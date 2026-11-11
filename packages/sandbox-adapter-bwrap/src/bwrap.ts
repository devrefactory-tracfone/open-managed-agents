// bubblewrap implementation of SandboxPort for the Node self-host.
//
// Every command runs in a fresh bwrap jail over the session's host dirs:
//
//   /workspace            ← ctx.workdir
//   /tmp                  ← <workdir>.oma-state/tmp     (persists across execs)
//   /mnt/memory           ← <workdir>.oma-state/memory  (file-synced Memory Stores)
//   /mnt/session/outputs  ← <outputsRoot>/<tenant>/<session> (after mountSessionOutputs)
//   /opt/oma              ← toolchain (read-only); its Nix closure is bound read-only
//   /run/oma/cmd.sh       ← this run's script (read-only)
//
// The adapter's own state (bind sources for /tmp and /mnt/memory, run
// scripts, passwd) lives in a sibling of the workdir that no jail can see.
// Keeping it out of /workspace matters: bwrap resolves bind sources on the
// host and follows symlinks, so a bind source the agent could replace would
// let the next jail mount any host path.
//
// Isolation: new user/pid/ipc/uts/cgroup namespaces, host network shared,
// empty environment (no host env leaks into the jail), nothing from the host
// filesystem except the binds above. Optionally the jail runs as a dedicated
// user via sudo, so an escape lands in an account that cannot read the
// server's secrets; egress for that uid is then filtered by the host firewall.
//
// Commands and their environment (including registered secrets) are written
// to a per-run script instead of argv, so they never show up in `ps` for
// other host users.
//
// Control-plane file reads and writes also run inside a jail (`cat`), so the
// server never follows a path the agent can modify; symlinks resolve within
// the jail's own view.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  rejectPreparedBase,
  rejectSandboxImageSelection,
  type ProcessHandle,
  type SandboxDuplexProcess,
  type SandboxDuplexProcessPort,
  type SandboxDuplexProcessSpec,
  type SandboxFactory,
  type SandboxPort,
  type SandboxSessionOutputMountPort,
} from "@open-managed-agents/sandbox";
import { getLogger } from "@open-managed-agents/observability";
import type { BwrapSandboxOptions } from "./options";

const logger = getLogger("bwrap-sandbox");

const TOOLCHAIN_MOUNT = "/opt/oma";
const CA_BUNDLE = `${TOOLCHAIN_MOUNT}/etc/ssl/certs/ca-bundle.crt`;
const JAIL_SCRIPT = "/run/oma/cmd.sh";
const FILE_OP_TIMEOUT_MS = 60_000;
/** Host files the jail may read for name resolution; missing ones are skipped. */
const HOST_ETC_FILES = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"];

type Root = "/workspace" | "/tmp" | "/mnt/memory" | "/mnt/session/outputs";
const ROOTS: readonly Root[] = ["/mnt/session/outputs", "/mnt/memory", "/workspace", "/tmp"];

export interface BwrapSandboxInit extends BwrapSandboxOptions {
  workdir: string;
  outputsRoot?: string;
}

/** One prepared jail launch: argv plus how to kill and clean it up. */
interface Run {
  id: string;
  argv: string[];
  cleanup(): void;
}

export class BwrapSandbox implements SandboxPort, SandboxDuplexProcessPort, SandboxSessionOutputMountPort {
  private readonly workdir: string;
  private readonly stateDir: string;
  private readonly outputsRoot: string | null;
  private outputsDir: string | null = null;
  private readonly defaultTimeoutMs: number;
  private envVars: Record<string, string> = {};
  private readonly commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private readonly processes = new Map<ChildProcess, Run>();
  private readonly duplex = new Set<SandboxDuplexProcess>();
  private destroyed = false;

  constructor(private readonly opts: BwrapSandboxInit) {
    this.workdir = resolve(opts.workdir);
    this.stateDir = `${this.workdir}.oma-state`;
    this.outputsRoot = opts.outputsRoot ? resolve(opts.outputsRoot) : null;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    for (const dir of [this.workdir, this.stateDir, ...["tmp", "memory", "run", "etc"].map((d) => join(this.stateDir, d))]) {
      this.ensureDir(dir);
    }
    // /tmp is world-writable with sticky bit, like a real /tmp.
    chmodSync(join(this.stateDir, "tmp"), 0o1777);
    this.writeIdentityFiles();
  }

  // ── Process execution ────────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const { code, signal, stdout, stderr } = await this.runToCompletion(
      this.prepareRun({ shell: command }, command),
      timeout ?? this.defaultTimeoutMs,
    );
    if (code === null && signal === null) return `[error: ${stderr}]`;
    const exit = signal ? `signal=${signal}` : `exit=${code}`;
    // Same shape as LocalSubprocessSandbox / @cloudflare/sandbox:
    // combined output, trailing whitespace trimmed, exit suffix on failure.
    const out = stdout.toString();
    return (out + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") + (code !== 0 ? `\n[exit ${exit}]` : "");
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const run = this.prepareRun({ shell: command }, command);
    const child = spawn(run.argv[0]!, run.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    if (!child.pid) {
      run.cleanup();
      return null;
    }
    this.processes.set(child, run);
    child.on("close", () => {
      this.processes.delete(child);
      run.cleanup();
    });
    return new BackgroundProcess(`proc_${child.pid}_${Date.now()}`, child, (signal) => this.signalRun(run, child, signal));
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const run = this.prepareRun(
      { argv: [spec.command, ...(spec.args ?? [])], env: spec.env, cwd: spec.cwd },
      spec.command,
    );
    const child = spawn(run.argv[0]!, run.argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        run.cleanup();
        resolveExit({ code, signal });
      };
      child.once("exit", settle);
      child.once("error", () => settle(null, null));
    });
    const proc: SandboxDuplexProcess = {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
      exited,
      kill: async (signal = "SIGTERM") => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        this.signalRun(run, child, signal);
        if (await settledWithin(exited, 2_000)) return;
        this.signalRun(run, child, "SIGKILL");
        await settledWithin(exited, 2_000);
      },
    };
    this.duplex.add(proc);
    void exited.then(() => this.duplex.delete(proc));
    return proc;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  // ── Session outputs ──────────────────────────────────────────────────

  sessionOutputMountCapabilities(): { durability: "durable" } | null {
    return this.outputsRoot === null ? null : { durability: "durable" };
  }

  async mountSessionOutputs(opts: { tenantId: string; sessionId: string }): Promise<void> {
    if (!this.outputsRoot) throw new Error("BwrapSandbox.mountSessionOutputs: outputsRoot not configured");
    const tenantDir = join(this.outputsRoot, safeSegment(opts.tenantId));
    this.ensureDir(tenantDir);
    const dir = join(tenantDir, safeSegment(opts.sessionId));
    this.ensureDir(dir);
    this.outputsDir = dir;
    await this.setEnvVars({ OMA_OUTPUTS_DIR: "/mnt/session/outputs" });
  }

  // ── Files (inside a jail, so paths resolve in the jail's view) ───────

  async readFile(path: string): Promise<string> {
    return (await this.readFileBuffer(path)).toString("utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await this.readFileBuffer(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBuffer(path, Buffer.from(content, "utf8"));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    return this.writeFileBuffer(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await Promise.all([...this.duplex].map((proc) => proc.kill("SIGKILL").catch(() => undefined)));
    this.duplex.clear();
    for (const [child, run] of this.processes) this.signalRun(run, child, "SIGKILL");
    this.processes.clear();
    // The jail may have created read-only dirs, or (with runAs) entries the
    // server user cannot delete; clear them from inside first.
    await this.exec(
      "chmod -R a+rwX /workspace /tmp /mnt/memory 2>/dev/null; find /workspace /tmp /mnt/memory -mindepth 1 -delete 2>/dev/null; true",
      60_000,
    ).catch(() => undefined);
    for (const dir of [this.workdir, this.stateDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, dir }, "destroy: failed to remove sandbox dir");
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async readFileBuffer(path: string): Promise<Buffer> {
    const logical = this.logicalPath(path);
    const result = await this.runToCompletion(
      this.prepareRun({ shell: `exec cat -- ${shellQuote(logical)}` }, ""),
      FILE_OP_TIMEOUT_MS,
    );
    if (result.code !== 0) throw fileError("read", logical, result.stderr);
    return result.stdout;
  }

  private async writeFileBuffer(path: string, content: Buffer): Promise<string> {
    const logical = this.logicalPath(path);
    const quoted = shellQuote(logical);
    const result = await this.runToCompletion(
      this.prepareRun({ shell: `mkdir -p -- "$(dirname -- ${quoted})" && exec cat > ${quoted}` }, ""),
      FILE_OP_TIMEOUT_MS,
      content,
    );
    if (result.code !== 0) throw fileError("write", logical, result.stderr);
    // The in-sandbox path, like E2B; callers may hand it back to commands.
    return logical;
  }

  /** Normalize to an absolute sandbox path under one of the mounted roots. */
  private logicalPath(path: string): string {
    const logical = posix.normalize(posix.isAbsolute(path) ? path : posix.join("/workspace", path));
    const root = ROOTS.find((r) => logical === r || logical.startsWith(`${r}/`));
    if (!root) throw new Error(`EACCES: ${path} is outside the sandbox (allowed: ${ROOTS.join(", ")})`);
    if (root === "/mnt/session/outputs" && !this.outputsDir) {
      throw new Error(`ENOENT: ${root} is not mounted in this sandbox`);
    }
    return logical;
  }

  /** Run to exit, collecting output; optional stdin. Timeout kills the jail. */
  private runToCompletion(
    run: Run,
    timeoutMs: number,
    stdin?: Buffer,
  ): Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: string }> {
    return new Promise((resolveRun) => {
      const child = spawn(run.argv[0]!, run.argv.slice(1), { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { out.push(chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      if (stdin) {
        child.stdin?.on("error", () => undefined); // jail may exit before reading everything
        child.stdin?.end(stdin);
      }
      const killer = setTimeout(() => {
        this.signalRun(run, child, "SIGTERM");
        setTimeout(() => this.signalRun(run, child, "SIGKILL"), 1_000).unref();
      }, timeoutMs);
      let done = false;
      const finish = (code: number | null, signal: string | null, extraErr = "") => {
        if (done) return;
        done = true;
        clearTimeout(killer);
        run.cleanup();
        resolveRun({ code, signal, stdout: Buffer.concat(out), stderr: stderr + extraErr });
      };
      child.on("close", (code, signal) => finish(code, signal));
      child.on("error", (err) => finish(null, null, err.message));
    });
  }

  /**
   * Signal a jail. Same uid: signal bwrap directly; SIGKILL on bwrap tears down
   * its pid namespace. runAs: the spawned child is sudo and bwrap runs as the
   * sandbox user, which the server uid cannot signal, so ask sudo to run pkill
   * as that user against the bwrap process carrying this run's id.
   */
  private signalRun(run: Run, child: ChildProcess, signal: NodeJS.Signals | string): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const runAs = this.opts.runAs;
    if (!runAs) {
      try { child.kill(signal as NodeJS.Signals); } catch { /* already gone */ }
      return;
    }
    const name = String(signal).replace(/^SIG/, "");
    const killer = spawn(runAs.sudoPath, ["-n", "-u", runAs.user, runAs.pkillPath, `-${name}`, "-f", "--", run.id], {
      stdio: "ignore",
    });
    killer.on("error", (err) => logger.warn({ err, run: run.id }, "bwrap: pkill via sudo failed"));
  }

  /**
   * Write the run script (env + umask + command) and build the launcher argv.
   * Secrets matching the command prefix are added for this run only. The run
   * id appears in bwrap's argv (script path) so pkill can find the jail.
   */
  private prepareRun(
    what: { shell: string } | { argv: string[]; env?: Record<string, string | undefined>; cwd?: string },
    commandForSecrets: string,
  ): Run {
    const env: Record<string, string> = { ...this.envVars };
    if (commandForSecrets) {
      for (const { prefix, secrets } of this.commandSecrets) {
        if (commandForSecrets.startsWith(prefix)) Object.assign(env, secrets);
      }
    }
    let cwd = "/workspace";
    let body: string;
    if ("shell" in what) {
      body = what.shell;
    } else {
      for (const [name, value] of Object.entries(what.env ?? {})) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
      if (what.cwd) cwd = posix.isAbsolute(what.cwd) ? what.cwd : posix.join("/workspace", what.cwd);
      body = `exec ${what.argv.map(shellQuote).join(" ")}`;
    }

    const lines = ["umask 0002"];
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
      lines.push(`export ${name}=${shellQuote(value)}`);
    }
    lines.push(body, "");

    const id = randomUUID();
    const hostScript = join(this.stateDir, "run", `${id}.sh`);
    // runAs: the sandbox user reads it through the shared group. Same uid: owner only.
    writeFileSync(hostScript, lines.join("\n"), { mode: this.opts.runAs ? 0o640 : 0o600 });
    if (this.opts.runAs) chownSync(hostScript, -1, this.opts.runAs.gid);
    const bwrap = [
      this.opts.bwrapPath,
      ...this.bwrapArgs(cwd),
      "--ro-bind", hostScript, JAIL_SCRIPT,
      "--", `${TOOLCHAIN_MOUNT}/bin/bash`, JAIL_SCRIPT,
    ];
    const argv = this.opts.runAs
      ? [this.opts.runAs.sudoPath, "-n", "-u", this.opts.runAs.user, ...bwrap]
      : bwrap;
    return { id, argv, cleanup: () => rmSync(hostScript, { force: true }) };
  }

  private bwrapArgs(cwd: string): string[] {
    const args = [
      "--unshare-all", "--share-net",
      "--die-with-parent", "--new-session",
      "--clearenv",
      "--hostname", "oma-sandbox",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/run",
    ];
    for (const path of this.opts.storePaths) args.push("--ro-bind", path, path);
    args.push("--ro-bind", this.opts.toolchainDir, TOOLCHAIN_MOUNT);
    args.push("--symlink", `${TOOLCHAIN_MOUNT}/bin/bash`, "/bin/sh");
    args.push("--symlink", `${TOOLCHAIN_MOUNT}/bin/bash`, "/bin/bash");
    args.push("--symlink", `${TOOLCHAIN_MOUNT}/bin/env`, "/usr/bin/env");
    for (const file of HOST_ETC_FILES) args.push("--ro-bind-try", file, file);
    args.push("--ro-bind", join(this.stateDir, "etc", "passwd"), "/etc/passwd");
    args.push("--ro-bind", join(this.stateDir, "etc", "group"), "/etc/group");
    args.push("--bind", this.workdir, "/workspace");
    args.push("--bind", join(this.stateDir, "tmp"), "/tmp");
    args.push("--bind", join(this.stateDir, "memory"), "/mnt/memory");
    if (this.outputsDir) args.push("--bind", this.outputsDir, "/mnt/session/outputs");
    args.push("--chdir", cwd);
    const baseEnv: Record<string, string> = {
      HOME: "/workspace",
      USER: "sandbox",
      LOGNAME: "sandbox",
      PATH: `${TOOLCHAIN_MOUNT}/bin:/usr/bin:/bin`,
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      SSL_CERT_FILE: CA_BUNDLE,
      GIT_SSL_CAINFO: CA_BUNDLE,
      NODE_EXTRA_CA_CERTS: CA_BUNDLE,
    };
    for (const [name, value] of Object.entries(baseEnv)) args.push("--setenv", name, value);
    return args;
  }

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    if (this.opts.runAs) {
      // Shared group + setgid so the sandbox user can use host-created dirs
      // and new entries keep the group.
      chownSync(dir, -1, this.opts.runAs.gid);
      chmodSync(dir, 0o2775);
    }
  }

  private writeIdentityFiles(): void {
    const uid = this.opts.runAs?.uid ?? process.getuid?.() ?? 1000;
    const gid = this.opts.runAs?.gid ?? process.getgid?.() ?? 1000;
    const etc = join(this.stateDir, "etc");
    writeFileSync(join(etc, "passwd"), `sandbox:x:${uid}:${gid}:sandbox:/workspace:${TOOLCHAIN_MOUNT}/bin/bash\n`, { mode: 0o644 });
    writeFileSync(join(etc, "group"), `sandbox:x:${gid}:\n`, { mode: 0o644 });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`unsafe path segment: ${value}`);
  }
  return value;
}

/** Map a failed in-jail cat to an fs-like error (callers check `code`). */
function fileError(op: "read" | "write", path: string, stderr: string): NodeJS.ErrnoException {
  const message = stderr.trim() || `${op} failed`;
  const code = /No such file or directory/.test(message) ? "ENOENT"
    : /Is a directory/.test(message) ? "EISDIR"
    : /Permission denied|Read-only file system/.test(message) ? "EACCES"
    : "EIO";
  return Object.assign(new Error(`${code}: ${op} ${path}: ${message}`), { code, path });
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class BackgroundProcess implements ProcessHandle {
  readonly pid: number;
  private stdout = "";
  private stderr = "";
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private killRequested = false;

  constructor(
    readonly id: string,
    child: ChildProcess,
    private readonly sendSignal: (signal: string) => void,
  ) {
    this.pid = child.pid ?? 0;
    child.stdout?.on("data", (b: Buffer) => { this.stdout += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { this.stderr += b.toString(); });
    child.on("close", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
  }

  async kill(signal: string): Promise<void> {
    this.killRequested = true;
    this.sendSignal(signal);
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  async getStatus(): Promise<string> {
    // Status vocabulary the harness polls for (see local-subprocess.ts).
    if (this.exitCode === null && this.exitSignal === null) return "running";
    // With runAs the child is sudo, which exits with a code after its jail is killed.
    if (this.exitSignal || (this.killRequested && this.exitCode !== 0)) return "killed";
    return this.exitCode === 0 ? "completed" : "error";
  }
}

/** Factory for `nodeDefaults(config, { sandbox })`. */
export function createBwrapSandboxFactory(options: BwrapSandboxOptions): SandboxFactory {
  if (!options.runAs) {
    logger.warn(
      { op: "bwrap.same_uid" },
      "bwrap sandbox runs as the server's own uid; set OMA_BWRAP_RUN_AS to a dedicated user in production",
    );
  }
  const factory = async (ctx: Parameters<SandboxFactory>[0]) => {
    rejectSandboxImageSelection("bwrap", ctx.image);
    rejectPreparedBase("bwrap", ctx.preparedBase);
    return new BwrapSandbox({ ...options, workdir: ctx.workdir, ...(ctx.outputsRoot ? { outputsRoot: ctx.outputsRoot } : {}) });
  };
  return Object.assign(factory, { capabilities: { allocationIsolation: true } });
}
