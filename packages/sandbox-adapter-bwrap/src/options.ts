// Environment → BwrapSandboxOptions. Kept separate from the adapter so the
// adapter stays testable with explicit options and never reads process.env.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SandboxFactoryEnv } from "@open-managed-agents/sandbox";

export interface BwrapRunAs {
  /** Unprivileged account the sandboxed commands run as. */
  user: string;
  uid: number;
  gid: number;
  /** sudo binary; the host must allow `<server user> → (user) NOPASSWD: <bwrapPath>, <pkillPath>`. */
  sudoPath: string;
  /** pkill run as `user` through sudo to signal jails (the server uid cannot signal them). */
  pkillPath: string;
}

export interface BwrapSandboxOptions {
  /** bubblewrap binary. With runAs it must match the sudoers rule exactly. */
  bwrapPath: string;
  /** Toolchain root (a Nix buildEnv) mounted read-only at /opt/oma. */
  toolchainDir: string;
  /** Host paths bound read-only at the same path: the toolchain's Nix closure. */
  storePaths: readonly string[];
  /** Run as a dedicated user via sudo. Unset: same uid as the server, inside a user namespace. */
  runAs?: BwrapRunAs;
  /** Default exec timeout (ms) when the caller passes none. */
  defaultTimeoutMs?: number;
}

/**
 * Read adapter configuration:
 *   OMA_BWRAP_TOOLCHAIN  required  toolchain root (mounted at /opt/oma)
 *   OMA_BWRAP_CLOSURE    required  file listing the toolchain closure, one store path per line
 *                                  (Nix `closureInfo`'s `store-paths`)
 *   OMA_BWRAP_BIN        optional  bubblewrap path (default: "bwrap" on PATH)
 *   OMA_BWRAP_RUN_AS     optional  dedicated sandbox user
 *   OMA_BWRAP_SUDO       optional  sudo path (default /run/wrappers/bin/sudo, the NixOS wrapper)
 *   OMA_BWRAP_PKILL      optional  pkill path allowed by the sudo rule (default "pkill")
 */
export function loadBwrapOptions(env: SandboxFactoryEnv): BwrapSandboxOptions {
  const toolchainDir = required(env, "OMA_BWRAP_TOOLCHAIN");
  const closureFile = required(env, "OMA_BWRAP_CLOSURE");
  const storePaths = readFileSync(closureFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (storePaths.length === 0) throw new Error(`OMA_BWRAP_CLOSURE=${closureFile} lists no store paths`);

  const user = env.OMA_BWRAP_RUN_AS?.trim();
  return {
    bwrapPath: env.OMA_BWRAP_BIN?.trim() || "bwrap",
    toolchainDir,
    storePaths,
    ...(user
      ? { runAs: lookupRunAs(user, env.OMA_BWRAP_SUDO?.trim() || "/run/wrappers/bin/sudo", env.OMA_BWRAP_PKILL?.trim() || "pkill") }
      : {}),
  };
}

function required(env: SandboxFactoryEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the bwrap sandbox`);
  return value;
}

function lookupRunAs(user: string, sudoPath: string, pkillPath: string): BwrapRunAs {
  const id = (flag: string): number => {
    const out = execFileSync("id", [flag, user], { encoding: "utf8" }).trim();
    const value = Number.parseInt(out, 10);
    if (!Number.isInteger(value)) throw new Error(`id ${flag} ${user} returned ${out}`);
    return value;
  };
  return { user, uid: id("-u"), gid: id("-g"), sudoPath, pkillPath };
}
