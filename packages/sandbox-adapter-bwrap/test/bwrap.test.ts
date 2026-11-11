// Integration tests against a real bubblewrap. They need a toolchain + its
// closure (OMA_BWRAP_TOOLCHAIN, OMA_BWRAP_CLOSURE) and are skipped otherwise.
// Optional OMA_BWRAP_RUN_AS exercises the dedicated-user path.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BwrapSandbox, loadBwrapOptions, type BwrapSandboxOptions } from "../src";

function available(): BwrapSandboxOptions | null {
  if (!process.env.OMA_BWRAP_TOOLCHAIN || !process.env.OMA_BWRAP_CLOSURE) return null;
  try {
    execFileSync(process.env.OMA_BWRAP_BIN || "bwrap", ["--version"]);
  } catch {
    return null;
  }
  return loadBwrapOptions(process.env);
}

const options = available();
const baseDir = process.env.OMA_BWRAP_TEST_DIR || tmpdir();

describe.skipIf(options === null)("BwrapSandbox", () => {
  let root: string;
  let sandbox: BwrapSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(baseDir, "bwrap-test-"));
    sandbox = new BwrapSandbox({ ...options!, workdir: join(root, "work"), outputsRoot: join(root, "outputs") });
  });

  afterEach(async () => {
    await sandbox.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs commands in /workspace and reports exit codes", async () => {
    expect(await sandbox.exec("pwd && echo hi")).toBe("/workspace\nhi");
    // Same shape as LocalSubprocessSandbox: stdout + "\n" + stderr, then the exit suffix.
    expect(await sandbox.exec("echo oops >&2; exit 3")).toBe("\noops\n[exit exit=3]");
  });

  it("kills commands that exceed the timeout", async () => {
    const started = Date.now();
    const out = await sandbox.exec("sleep 30", 500);
    expect(out).toMatch(/\[exit (signal=SIG(TERM|KILL)|exit=1\d\d)\]/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not leak the host environment", async () => {
    process.env.OMA_TEST_PLANTED_SECRET = "do-not-leak";
    try {
      const env = await sandbox.exec("env");
      expect(env).not.toContain("do-not-leak");
      expect(env).toContain("HOME=/workspace");
    } finally {
      delete process.env.OMA_TEST_PLANTED_SECRET;
    }
  });

  it("does not expose host files outside the binds", async () => {
    const secret = join(root, "host-secret.txt");
    writeFileSync(secret, "top secret");
    expect(await sandbox.exec(`cat ${secret}`)).toMatch(/No such file or directory[\s\S]*\[exit exit=1\]/);
    expect(await sandbox.exec("ls /home 2>&1; ls /etc")).not.toContain("shadow");
  });

  it("passes env vars and command-scoped secrets without putting them on argv", async () => {
    await sandbox.setEnvVars({ GREETING: "it's fine" });
    sandbox.registerCommandSecrets("git", { GIT_TOKEN: "s3cret" });
    expect(await sandbox.exec("echo $GREETING")).toBe("it's fine");
    expect(await sandbox.exec("echo [$GIT_TOKEN]")).toBe("[]");
    expect(await sandbox.exec("git --version >/dev/null; echo [$GIT_TOKEN]")).toBe("[s3cret]");
  });

  it("keeps /tmp across commands and maps files both ways", async () => {
    await sandbox.exec("echo kept > /tmp/state");
    expect(await sandbox.exec("cat /tmp/state")).toBe("kept");
    expect(await sandbox.readFile("/tmp/state")).toBe("kept\n");
    await sandbox.writeFile("/workspace/dir/note.txt", "from host");
    expect(await sandbox.exec("cat dir/note.txt")).toBe("from host");
    await sandbox.writeFileBytes("bin.dat", new Uint8Array([0, 255, 1]));
    expect([...(await sandbox.readFileBytes("/workspace/bin.dat"))]).toEqual([0, 255, 1]);
  });

  it("rejects paths outside the sandbox roots and symlink escapes", async () => {
    await expect(sandbox.readFile("/etc/passwd")).rejects.toThrow(/outside the sandbox/);
    await expect(sandbox.readFile("/workspace/../../etc/passwd")).rejects.toThrow(/outside the sandbox/);
    const secret = join(root, "host-secret.txt");
    writeFileSync(secret, "top secret");
    symlinkSync(secret, join(root, "work", "escape"));
    // File ops run inside the jail, where the host path does not exist.
    await expect(sandbox.readFile("/workspace/escape")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sandbox.writeFile("/workspace/escape", "x")).rejects.toThrow();
    expect(readFileSync(secret, "utf8")).toBe("top secret");
  });

  it("returns the in-sandbox path from writeFile", async () => {
    expect(await sandbox.writeFile("relay/entry.cjs", "x")).toBe("/workspace/relay/entry.cjs");
  });

  it("keeps adapter state out of /workspace so bind sources cannot be swapped", async () => {
    const hostDir = join(root, "host-dir");
    mkdirSync(hostDir);
    writeFileSync(join(hostDir, "key"), "host key");
    expect(await sandbox.exec("ls -A /workspace")).toBe("");
    // The attack that worked when state lived under /workspace: repoint the
    // /tmp bind source at a host dir, then read it in the next jail.
    await sandbox.exec(`mkdir -p /workspace/.oma-sandbox && ln -sfn ${hostDir} /workspace/.oma-sandbox/tmp && ln -sfn ${hostDir} /workspace/.oma-state`);
    expect(await sandbox.exec("cat /tmp/key")).toMatch(/No such file or directory/);
    expect(await sandbox.exec("ls -A /tmp")).toBe("");
    // The state dir itself is a host sibling of the workdir, never mounted.
    expect(existsSync(join(root, "work.oma-state", "tmp"))).toBe(true);
  });

  it("never serves host files while a jail process flips symlinks", async () => {
    const secret = join(root, "host-secret.txt");
    writeFileSync(secret, "top secret");
    await sandbox.writeFile("/workspace/real.txt", "safe");
    const flipper = await sandbox.startProcess(
      `while true; do ln -sfn ${secret} /workspace/flip; ln -sfn /workspace/real.txt /workspace/flip; done`,
    );
    try {
      for (let i = 0; i < 20; i++) {
        const content = await sandbox.readFile("/workspace/flip").catch(() => "");
        expect(content).not.toContain("top secret");
      }
    } finally {
      await flipper!.kill("SIGKILL");
    }
  });

  it("mounts session outputs visible on the host", async () => {
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountSessionOutputs({ tenantId: "t1", sessionId: "s1" });
    await sandbox.exec("echo report > /mnt/session/outputs/r.txt");
    expect(readFileSync(join(root, "outputs", "t1", "s1", "r.txt"), "utf8")).toBe("report\n");
    expect(await sandbox.readFile("/mnt/session/outputs/r.txt")).toBe("report\n");
  });

  it("runs background processes and kills them on destroy", async () => {
    const handle = await sandbox.startProcess("echo started; sleep 30");
    expect(handle).not.toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    expect(await handle!.getStatus()).toBe("running");
    expect((await handle!.getLogs()).stdout).toContain("started");
    await handle!.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(await handle!.getStatus()).toBe("killed");
  });

  it("spawns duplex processes with live stdio", async () => {
    const proc = await sandbox.spawnDuplexProcess({ command: "cat", env: { X: "1" } });
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode("ping\n"));
    await writer.close();
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("ping\n");
    expect((await proc.exited).code).toBe(0);
  });

  it("runs as the configured identity", async () => {
    const uid = options!.runAs?.uid ?? process.getuid!();
    expect(await sandbox.exec("id -u")).toBe(String(uid));
    expect(existsSync(join(root, "work.oma-state", "etc", "passwd"))).toBe(true);
  });

  it("removes the workdir on destroy", async () => {
    await sandbox.exec("mkdir -p a/b && echo x > a/b/c && chmod 500 a/b");
    await sandbox.destroy();
    expect(existsSync(join(root, "work"))).toBe(false);
    expect(existsSync(join(root, "work.oma-state"))).toBe(false);
  });
});

// runAs path with a sudo shim (same uid): exercises signalling through
// "sudo -u <user> pkill" instead of signalling the child directly.
describe.skipIf(options === null)("BwrapSandbox runAs signalling", () => {
  let root: string;
  let sandbox: BwrapSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(baseDir, "bwrap-runas-"));
    const shim = join(root, "sudo");
    writeFileSync(shim, '#!/bin/sh\n# drop "-n -u <user>" and run the command as the caller\nshift 3\nexec "$@"\n');
    chmodSync(shim, 0o755);
    sandbox = new BwrapSandbox({
      ...options!,
      runAs: {
        user: userInfo().username,
        uid: process.getuid!(),
        gid: process.getgid!(),
        sudoPath: shim,
        pkillPath: join(options!.toolchainDir, "bin", "pkill"),
      },
      workdir: join(root, "work"),
      outputsRoot: join(root, "outputs"),
    });
  });

  afterEach(async () => {
    await sandbox.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("enforces exec timeouts through pkill", async () => {
    const started = Date.now();
    expect(await sandbox.exec("sleep 30", 500)).toMatch(/\[exit /);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills background processes through pkill", async () => {
    const handle = await sandbox.startProcess("sleep 30");
    await new Promise((r) => setTimeout(r, 300));
    await handle!.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    expect(await handle!.getStatus()).toBe("killed");
  });

  it("shares host-created dirs with the sandbox group", async () => {
    expect(await sandbox.exec("stat -c %a /workspace")).toBe("2775");
  });
});
