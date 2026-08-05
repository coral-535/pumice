import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveRuntime(worktreePath = process.cwd()) {
  const canonicalPath = await realpath(worktreePath);
  const worktree = await findWorktreeRoot(canonicalPath);
  const identity = createHash("sha256").update(worktree).digest("hex").slice(0, 24);
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  const directory = join(tmpdir(), `pumice-${user}`);
  return {
    worktree,
    directory,
    socketPath: join(directory, `${identity}.sock`),
    lockPath: join(directory, `${identity}.lock`),
  };
}

async function findWorktreeRoot(path) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return realpath(stdout.trim());
  } catch {
    return path;
  }
}

export async function acquireDaemonLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await lockOwnerIsAlive(lockPath)) return null;
      await rm(lockPath, { force: true });
    }
  }
  return null;
}

async function lockOwnerIsAlive(lockPath) {
  let pid;
  try {
    pid = Number.parseInt(await readFile(lockPath, "utf8"), 10);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
