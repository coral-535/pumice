import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { deferred } from "./deferred.js";
import { definitionFingerprint, normalizePlan } from "./definitions.js";
import { ServiceConfigurationError, ServiceStartupError, serializeError } from "./errors.js";
import { JsonLineChannel } from "./ipc.js";
import { Service } from "./service.js";

export class DaemonServer {
  #connections = new Set();
  #services = new Map();
  #nextGeneration = 1;
  #server;
  #closing = false;
  #closePromise;
  #idleTimer;

  constructor(options) {
    if (!options?.socketPath) throw new TypeError("socketPath is required");
    this.socketPath = options.socketPath;
    this.idleTimeout = options.idleTimeout ?? null;
    this.#closed = deferred();
    this.closed = this.#closed.promise;
  }

  #closed;

  async listen() {
    if (this.#server) throw new Error("daemon is already listening");
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.socketPath, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    this.#scheduleIdleShutdown();
    return this;
  }

  get serviceCount() {
    return this.#services.size;
  }

  get connectionCount() {
    return this.#connections.size;
  }

  close() {
    if (!this.#closePromise) this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose() {
    this.#closing = true;
    clearTimeout(this.#idleTimer);

    for (const connection of this.#connections) connection.channel.destroy();
    this.#connections.clear();

    const stopping = [];
    for (const record of this.#services.values()) {
      record.state = "stopping";
      stopping.push(record.service[Symbol.asyncDispose]());
      stopping.push(record.ready);
    }
    this.#services.clear();
    await Promise.allSettled(stopping);

    if (this.#server) {
      await new Promise((resolve) => this.#server.close(() => resolve()));
      this.#server = undefined;
    }
    await rm(this.socketPath, { force: true });
    this.#closed.resolve();
  }

  #accept(socket) {
    clearTimeout(this.#idleTimer);
    const connection = {
      channel: new JsonLineChannel(socket),
      references: new Map(),
      closed: false,
    };
    this.#connections.add(connection);
    connection.channel.onMessage((message) => void this.#handleMessage(connection, message));
    connection.channel.onClose(() => this.#connectionClosed(connection));
  }

  async #handleMessage(connection, message) {
    if (message?.type !== "request" || !Number.isSafeInteger(message.id)) return;
    try {
      let result;
      switch (message.method) {
        case "acquire-plan":
          result = await this.#acquirePlan(connection, message.params?.plan);
          break;
        case "ping":
          result = { protocol: 1 };
          break;
        default:
          throw new TypeError(`unknown daemon method ${JSON.stringify(message.method)}`);
      }
      connection.channel.send({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      connection.channel.send({
        type: "response",
        id: message.id,
        ok: false,
        error: serializeError(error),
      });
    }
  }

  async #acquirePlan(connection, input) {
    const plan = normalizePlan(input);
    const added = [];
    const acquired = [];
    try {
      for (const definition of plan.services) {
        const result = await this.#acquire(connection, definition);
        acquired.push(result.publicRecord);
        if (result.added) added.push(result.record);
      }
      return { services: acquired };
    } catch (error) {
      for (const record of added.reverse()) this.#release(connection, record);
      throw error;
    }
  }

  async #acquire(connection, definition) {
    const fingerprint = definitionFingerprint(definition);
    let record = this.#services.get(definition.name);
    if (record && record.fingerprint !== fingerprint) {
      throw new ServiceConfigurationError(definition.name);
    }

    if (!record) {
      record = this.#startRecord(definition, fingerprint);
      this.#services.set(definition.name, record);
    }

    const added = !connection.references.has(definition.name);
    if (added) {
      connection.references.set(definition.name, record);
      record.connections.add(connection);
    }

    await record.ready;
    if (this.#services.get(definition.name) !== record) {
      throw new ServiceStartupError(definition.name, "generation was released during startup");
    }
    return {
      added,
      record,
      publicRecord: { name: definition.name, generation: record.generation },
    };
  }

  #startRecord(definition, fingerprint) {
    const generation = this.#nextGeneration++;
    const service = Service.start(definition, generation);
    const record = {
      definition,
      fingerprint,
      generation,
      service,
      state: "starting",
      connections: new Set(),
      ready: undefined,
    };

    service.exited.then((result) => this.#serviceExited(record, result));
    record.ready = service.waitUntilHealthy().then(
      () => {
        if (this.#services.get(definition.name) === record) record.state = "ready";
      },
      async (error) => {
        if (this.#services.get(definition.name) === record) {
          this.#services.delete(definition.name);
        }
        for (const connection of record.connections) {
          if (connection.references.get(definition.name) === record) {
            connection.references.delete(definition.name);
          }
        }
        record.connections.clear();
        record.state = "stopping";
        await service[Symbol.asyncDispose]();
        this.#scheduleIdleShutdown();
        throw error;
      },
    );
    return record;
  }

  #serviceExited(record, result) {
    if (record.state !== "ready") return;
    if (this.#services.get(record.definition.name) !== record) return;

    this.#services.delete(record.definition.name);
    const event = {
      type: "service-exited",
      service: record.definition.name,
      generation: record.generation,
      code: result.code,
      signal: result.signal,
    };
    for (const connection of record.connections) {
      if (connection.references.get(record.definition.name) === record) {
        connection.references.delete(record.definition.name);
        connection.channel.send({ type: "event", event });
      }
    }
    record.connections.clear();
    this.#scheduleIdleShutdown();
  }

  #connectionClosed(connection) {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
    for (const record of [...connection.references.values()]) this.#release(connection, record);
    connection.references.clear();
    this.#scheduleIdleShutdown();
  }

  #release(connection, record) {
    if (connection.references.get(record.definition.name) !== record) return;
    connection.references.delete(record.definition.name);
    record.connections.delete(connection);
    if (record.connections.size !== 0) return;
    if (this.#services.get(record.definition.name) !== record) return;

    this.#services.delete(record.definition.name);
    record.state = "stopping";
    void record.service[Symbol.asyncDispose]().finally(() => this.#scheduleIdleShutdown());
  }

  #scheduleIdleShutdown() {
    if (this.#closing || this.idleTimeout === null) return;
    clearTimeout(this.#idleTimer);
    if (this.#connections.size !== 0 || this.#services.size !== 0) return;
    this.#idleTimer = setTimeout(() => void this.close(), this.idleTimeout);
    this.#idleTimer.unref?.();
  }
}
