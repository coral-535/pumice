import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { deferred } from "./deferred.js";
import { normalizePlan } from "./definitions.js";
import { DaemonDisconnectedError, ServiceExitedError, deserializeError } from "./errors.js";
import { JsonLineChannel } from "./ipc.js";
import { resolveRuntime } from "./runtime.js";

const DAEMON_ENTRY = fileURLToPath(new URL("../bin/pumice-daemon.js", import.meta.url));

export class ServiceGuard {
  #channel;
  #failure = deferred();
  #failureSettled = false;
  #listeners = new Set();
  #nextRequestId = 1;
  #pending = new Map();
  #disposing = false;
  #disposed = false;
  #disposePromise;

  constructor(channel) {
    this.#channel = channel;
    this.failure = this.#failure.promise;
    channel.onMessage((message) => this.#receive(message));
    channel.onClose(() => this.#disconnected());
  }

  static async connect(worktreePath = process.cwd(), options = {}) {
    const runtime = options.socketPath
      ? {
          worktree: worktreePath,
          socketPath: options.socketPath,
          lockPath: options.lockPath ?? `${options.socketPath}.lock`,
        }
      : await resolveRuntime(worktreePath);
    const socket = await connectOrStart(runtime, options);
    return new ServiceGuard(new JsonLineChannel(socket));
  }

  run(plan) {
    if (this.#disposed || this.#disposing) throw new Error("ServiceGuard is disposed");
    return this.#request("acquire-plan", { plan: normalizePlan(plan) });
  }

  onEvent(listener) {
    if (this.#disposed || this.#disposing) throw new Error("ServiceGuard is disposed");
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
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

  [Symbol.asyncDispose]() {
    if (!this.#disposePromise) this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  async #dispose() {
    this.#disposing = true;
    const closed = new Promise((resolve) => this.#channel.onClose(resolve));
    this.#channel.end();
    const timer = setTimeout(() => this.#channel.destroy(), 1_000);
    timer.unref?.();
    await closed;
    clearTimeout(timer);
    this.#disposed = true;
    this.#disposing = false;
    this.#listeners.clear();
  }

  #request(method, params) {
    const id = this.#nextRequestId++;
    const result = deferred();
    this.#pending.set(id, result);
    if (!this.#channel.send({ type: "request", id, method, params })) {
      this.#pending.delete(id);
      throw new DaemonDisconnectedError();
    }
    return result.promise;
  }

  #receive(message) {
    if (message?.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(deserializeError(message.error));
      return;
    }
    if (message?.type !== "event" || !message.event) return;
    this.#emit(message.event);
    if (message.event.type === "service-exited") {
      this.#fail(new ServiceExitedError(message.event));
    }
  }

  #disconnected() {
    const unexpected = !this.#disposing && !this.#disposed;
    const error = new DaemonDisconnectedError();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!unexpected) return;
    this.#emit({ type: "daemon-disconnected" });
    this.#fail(error);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
  }

  #fail(error) {
    if (this.#failureSettled) return;
    this.#failureSettled = true;
    this.#failure.resolve(error);
  }
}

async function connectOrStart(runtime, options) {
  const timeout = options.connectTimeout ?? 5_000;
  const deadline = Date.now() + timeout;
  let launched = false;
  let lastError;
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
  throw new DaemonDisconnectedError(`could not connect to the Pumice daemon at ${runtime.socketPath}`, {
    cause: lastError,
  });
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function launchDaemon(runtime, options) {
  const child = spawn(process.execPath, [
    options.daemonEntry ?? DAEMON_ENTRY,
    "--socket", runtime.socketPath,
    "--lock", runtime.lockPath,
  ], {
    cwd: runtime.worktree,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
