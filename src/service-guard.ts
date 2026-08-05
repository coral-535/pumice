import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { deferred, type Deferred } from "./deferred.ts";
import { normalizePlan, type Plan, type ServiceDefinition } from "./definitions.ts";
import type { AcquiredPlan } from "./daemon.ts";
import { DaemonDisconnectedError, ServiceExitedError, deserializeError } from "./errors.ts";
import { JsonLineChannel } from "./ipc.ts";
import { resolveRuntime, type RuntimePaths } from "./runtime.ts";

const DAEMON_ENTRY = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./daemon-cli.ts" : "./daemon-cli.mjs",
    import.meta.url,
  ),
);

export type DaemonEvent =
  | {
      type: "service-exited";
      service: string;
      generation: number;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | { type: "daemon-disconnected" };

export interface ServiceGuardOptions {
  socketPath?: string;
  lockPath?: string;
  connectTimeout?: number;
  startDaemon?: boolean;
  daemonEntry?: string;
}

type DaemonFailure = DaemonDisconnectedError | ServiceExitedError;
type DaemonRuntime = Pick<RuntimePaths, "worktree" | "socketPath" | "lockPath">;

export class ServiceGuard implements AsyncDisposable {
  readonly failure: Promise<DaemonFailure>;

  #channel: JsonLineChannel;
  #failure: Deferred<DaemonFailure> = deferred<DaemonFailure>();
  #failureSettled = false;
  #listeners = new Set<(event: DaemonEvent) => void>();
  #nextRequestId = 1;
  #pending = new Map<number, Deferred<unknown>>();
  #disposing = false;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(channel: JsonLineChannel) {
    this.#channel = channel;
    this.failure = this.#failure.promise;
    channel.onMessage((message) => this.#receive(message));
    channel.onClose(() => this.#disconnected());
  }

  static async connect(
    worktreePath = process.cwd(),
    options: ServiceGuardOptions = {},
  ): Promise<ServiceGuard> {
    const runtime: DaemonRuntime = options.socketPath
      ? {
          worktree: worktreePath,
          socketPath: options.socketPath,
          lockPath: options.lockPath ?? `${options.socketPath}.lock`,
        }
      : await resolveRuntime(worktreePath);
    const socket = await connectOrStart(runtime, options);
    return new ServiceGuard(new JsonLineChannel(socket));
  }

  run(plan: Plan | ServiceDefinition[]): Promise<AcquiredPlan> {
    if (this.#disposed || this.#disposing) throw new Error("ServiceGuard is disposed");
    return this.#request<AcquiredPlan>("acquire-plan", { plan: normalizePlan(plan) });
  }

  onEvent(listener: (event: DaemonEvent) => void): Disposable {
    if (this.#disposed || this.#disposing) throw new Error("ServiceGuard is disposed");
    this.#listeners.add(listener);
    let disposed = false;
    return {
      [Symbol.dispose]: () => {
        if (disposed) return;
        disposed = true;
        this.#listeners.delete(listener);
      },
    };
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposing = true;
    const closed = new Promise<void>((resolve) => {
      this.#channel.onClose(resolve);
    });
    this.#channel.end();
    const timer = setTimeout(() => this.#channel.destroy(), 1_000);
    timer.unref?.();
    await closed;
    clearTimeout(timer);
    this.#disposed = true;
    this.#disposing = false;
    this.#listeners.clear();
  }

  #request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextRequestId++;
    const result = deferred<unknown>();
    this.#pending.set(id, result);
    if (!this.#channel.send({ type: "request", id, method, params })) {
      this.#pending.delete(id);
      throw new DaemonDisconnectedError();
    }
    return result.promise as Promise<T>;
  }

  #receive(input: unknown): void {
    const message = asRecord(input);
    if (message.type === "response" && typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(deserializeError(message.error));
      return;
    }
    if (message.type !== "event") return;
    const event = parseDaemonEvent(message.event);
    if (!event) return;
    this.#emit(event);
    if (event.type === "service-exited") this.#fail(new ServiceExitedError(event));
  }

  #disconnected(): void {
    const unexpected = !this.#disposing && !this.#disposed;
    const error = new DaemonDisconnectedError();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!unexpected) return;
    this.#emit({ type: "daemon-disconnected" });
    this.#fail(error);
  }

  #emit(event: DaemonEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  #fail(error: DaemonFailure): void {
    if (this.#failureSettled) return;
    this.#failureSettled = true;
    this.#failure.resolve(error);
  }
}

async function connectOrStart(
  runtime: DaemonRuntime,
  options: ServiceGuardOptions,
): Promise<Socket> {
  const timeout = options.connectTimeout ?? 5_000;
  const deadline = Date.now() + timeout;
  let launched = false;
  let lastError: unknown;
  do {
    try {
      return await connectSocket(runtime.socketPath);
    } catch (error) {
      lastError = error;
      if (options.startDaemon === false) throw error;
      if (!launched) {
        launchDaemon(runtime, options);
        launched = true;
      }
      await delay(25);
    }
  } while (Date.now() < deadline);
  throw new DaemonDisconnectedError(
    `could not connect to the Pumice daemon at ${runtime.socketPath}`,
    {
      cause: lastError,
    },
  );
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function launchDaemon(runtime: DaemonRuntime, options: ServiceGuardOptions): void {
  const child = spawn(
    process.execPath,
    [
      options.daemonEntry ?? DAEMON_ENTRY,
      "--socket",
      runtime.socketPath,
      "--lock",
      runtime.lockPath,
    ],
    { cwd: runtime.worktree, detached: true, stdio: "ignore" },
  );
  child.unref();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseDaemonEvent(input: unknown): DaemonEvent | undefined {
  const event = asRecord(input);
  if (event.type === "daemon-disconnected") return { type: "daemon-disconnected" };
  if (
    event.type !== "service-exited" ||
    typeof event.service !== "string" ||
    typeof event.generation !== "number"
  ) {
    return undefined;
  }
  return {
    type: "service-exited",
    service: event.service,
    generation: event.generation,
    code: typeof event.code === "number" ? event.code : null,
    signal: typeof event.signal === "string" ? (event.signal as NodeJS.Signals) : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
