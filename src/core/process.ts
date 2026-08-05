import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

export interface ManagedProcessOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: StdioOptions;
  terminationGracePeriod?: number;
}

export class ManagedProcess implements AsyncDisposable {
  readonly command: string;
  readonly terminationGracePeriod: number;
  readonly pid: number | undefined;
  readonly spawned: Promise<void>;
  readonly exited: Promise<ProcessResult>;

  #child: ChildProcess;
  #finished = false;
  #termination: Promise<ProcessResult> | undefined;

  constructor(command: string, options: ManagedProcessOptions = {}) {
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
    this.spawned = new Promise<void>((resolve, reject) => {
      this.#child.once("spawn", resolve);
      this.#child.once("error", reject);
    });
    void this.spawned.catch(() => {});
    this.exited = new Promise<ProcessResult>((resolve) => {
      let settled = false;
      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        this.#finished = true;
        resolve(Object.freeze(result));
      };
      this.#child.once("exit", (code, signal) => finish({ code, signal, error: null }));
      this.#child.once("error", (error) => finish({ code: null, signal: null, error }));
    });
  }

  get finished(): boolean {
    return this.#finished;
  }

  terminate(): Promise<ProcessResult> {
    this.#termination ??= this.#terminate();
    return this.#termination;
  }

  async #terminate(): Promise<ProcessResult> {
    if (this.pid === undefined) return this.exited;
    if (this.#finished && !this.#groupIsAlive()) return this.exited;

    this.#signal("SIGTERM");
    const graceful = await waitForProcessGroup(this, this.terminationGracePeriod);
    if (graceful) return this.exited;

    this.#signal("SIGKILL");
    await Promise.all([this.exited, waitForProcessGroup(this, 1_000)]);
    return this.exited;
  }

  #signal(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    try {
      if (process.platform === "win32") this.#child.kill(signal);
      else process.kill(-this.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  #groupIsAlive(): boolean {
    if (this.pid === undefined) return false;
    if (process.platform === "win32") return !this.#finished;
    try {
      process.kill(-this.pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  }

  groupIsAlive(): boolean {
    return this.#groupIsAlive();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.terminate();
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function waitForProcessGroup(
  managedProcess: ManagedProcess,
  milliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (managedProcess.groupIsAlive()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
  }
  return true;
}
