import { spawn } from "node:child_process";

export class ManagedProcess {
  #child;
  #finished = false;
  #termination;

  constructor(command, options = {}) {
    this.command = command;
    this.terminationGracePeriod = options.terminationGracePeriod ?? 5_000;
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    this.#child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env,
      stdio: options.stdio ?? "inherit",
      detached: process.platform !== "win32",
    });
    this.pid = this.#child.pid;
    this.spawned = new Promise((resolve, reject) => {
      this.#child.once("spawn", resolve);
      this.#child.once("error", reject);
    });
    this.spawned.catch(() => {});
    this.exited = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.#finished = true;
        resolve(Object.freeze(result));
      };
      this.#child.once("exit", (code, signal) => finish({ code, signal, error: null }));
      this.#child.once("error", (error) => finish({ code: null, signal: null, error }));
    });
  }

  get finished() {
    return this.#finished;
  }

  terminate() {
    if (this.#termination) return this.#termination;
    this.#termination = this.#terminate();
    return this.#termination;
  }

  async #terminate() {
    if (this.pid === undefined) return this.exited;
    if (this.#finished && !this.#groupIsAlive()) return this.exited;

    this.#signal("SIGTERM");
    const graceful = await waitForProcessGroup(this, this.terminationGracePeriod);
    if (graceful) return this.exited;

    this.#signal("SIGKILL");
    await Promise.all([
      this.exited,
      waitForProcessGroup(this, 1_000),
    ]);
    return this.exited;
  }

  #signal(signal) {
    if (this.pid === undefined) return;
    try {
      if (process.platform === "win32") {
        this.#child.kill(signal);
      } else {
        process.kill(-this.pid, signal);
      }
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  #groupIsAlive() {
    if (this.pid === undefined) return false;
    if (process.platform === "win32") return !this.#finished;
    try {
      process.kill(-this.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code === "EPERM") return true;
      throw error;
    }
  }

  groupIsAlive() {
    return this.#groupIsAlive();
  }

  [Symbol.asyncDispose]() {
    return this.terminate();
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function waitForProcessGroup(managedProcess, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (managedProcess.groupIsAlive()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
  }
  return true;
}
