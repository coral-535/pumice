import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { deferred, type Deferred } from "./deferred.ts";
import {
  definitionFingerprint,
  normalizePlan,
  type NormalizedServiceDefinition,
} from "./definitions.ts";
import { ServiceConfigurationError, ServiceStartupError, serializeError } from "./errors.ts";
import { JsonLineChannel } from "./ipc.ts";
import type { ProcessResult } from "./process.ts";
import { Service } from "./service.ts";

export interface DaemonServerOptions {
  socketPath: string;
  idleTimeout?: number | null;
}

export interface AcquiredPlan {
  services: Array<{
    name: string;
    generation: number;
    action: "started" | "reused";
  }>;
}

interface DaemonConnection {
  channel: JsonLineChannel;
  references: Map<string, ServiceRecord>;
  closed: boolean;
}

interface ServiceRecord {
  definition: NormalizedServiceDefinition;
  fingerprint: string;
  generation: number;
  service: Service;
  state: "starting" | "ready" | "stopping";
  connections: Set<DaemonConnection>;
  ready: Promise<void>;
}

interface AcquireResult {
  added: boolean;
  record: ServiceRecord;
  publicRecord: AcquiredPlan["services"][number];
}

export class DaemonServer {
  readonly socketPath: string;
  readonly idleTimeout: number | null;
  readonly closed: Promise<void>;

  #connections = new Set<DaemonConnection>();
  #services = new Map<string, ServiceRecord>();
  #nextGeneration = 1;
  #server: Server | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #closed: Deferred<void>;

  constructor(options: DaemonServerOptions) {
    if (!options?.socketPath) throw new TypeError("socketPath is required");
    this.socketPath = options.socketPath;
    this.idleTimeout = options.idleTimeout ?? null;
    this.#closed = deferred<void>();
    this.closed = this.#closed.promise;
  }

  async listen(): Promise<this> {
    if (this.#server) throw new Error("daemon is already listening");
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.#scheduleIdleShutdown();
    return this;
  }

  get serviceCount(): number {
    return this.#services.size;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#idleTimer);

    for (const connection of this.#connections) connection.channel.destroy();
    this.#connections.clear();

    const stopping: Promise<unknown>[] = [];
    for (const record of this.#services.values()) {
      record.state = "stopping";
      stopping.push(record.service[Symbol.asyncDispose]());
      stopping.push(record.ready);
    }
    this.#services.clear();
    await Promise.allSettled(stopping);

    if (this.#server) {
      const server = this.#server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.#server = undefined;
    }
    await rm(this.socketPath, { force: true });
    this.#closed.resolve(undefined);
  }

  #accept(socket: Socket): void {
    clearTimeout(this.#idleTimer);
    const connection: DaemonConnection = {
      channel: new JsonLineChannel(socket),
      references: new Map(),
      closed: false,
    };
    this.#connections.add(connection);
    connection.channel.onMessage((message) => void this.#handleMessage(connection, message));
    connection.channel.onClose(() => this.#connectionClosed(connection));
  }

  async #handleMessage(connection: DaemonConnection, input: unknown): Promise<void> {
    const message = asRecord(input);
    if (message.type !== "request" || !Number.isSafeInteger(message.id)) return;
    const id = message.id as number;
    try {
      let result: unknown;
      switch (message.method) {
        case "acquire-plan":
          result = await this.#acquirePlan(connection, asRecord(message.params).plan);
          break;
        case "ping":
          result = { protocol: 1 };
          break;
        default:
          throw new TypeError(`unknown daemon method ${JSON.stringify(message.method)}`);
      }
      connection.channel.send({ type: "response", id, ok: true, result });
    } catch (error) {
      connection.channel.send({ type: "response", id, ok: false, error: serializeError(error) });
    }
  }

  async #acquirePlan(connection: DaemonConnection, input: unknown): Promise<AcquiredPlan> {
    const plan = normalizePlan(input);
    const added: ServiceRecord[] = [];
    const acquired: AcquiredPlan["services"] = [];
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

  async #acquire(
    connection: DaemonConnection,
    definition: NormalizedServiceDefinition,
  ): Promise<AcquireResult> {
    const fingerprint = definitionFingerprint(definition);
    let record = this.#services.get(definition.name);
    if (record && record.fingerprint !== fingerprint) {
      throw new ServiceConfigurationError(definition.name);
    }

    const action = record ? "reused" : "started";
    if (!record) {
      record = this.#startRecord(definition, fingerprint);
      this.#services.set(definition.name, record);
    }

    const added = !connection.references.has(definition.name);
    if (added) {
      connection.references.set(definition.name, record);
      record.connections.add(connection);
    }
    connection.channel.send({
      type: "service-acquisition",
      service: definition.name,
      generation: record.generation,
      action,
    });

    await record.ready;
    if (this.#services.get(definition.name) !== record) {
      throw new ServiceStartupError(definition.name, "generation was released during startup");
    }
    return {
      added,
      record,
      publicRecord: { name: definition.name, generation: record.generation, action },
    };
  }

  #startRecord(definition: NormalizedServiceDefinition, fingerprint: string): ServiceRecord {
    const generation = this.#nextGeneration++;
    const service = Service.start(definition, generation);
    const record: ServiceRecord = {
      definition,
      fingerprint,
      generation,
      service,
      state: "starting",
      connections: new Set(),
      ready: Promise.resolve(),
    };

    void service.exited.then((result) => this.#serviceExited(record, result));
    record.ready = service.waitUntilHealthy().then(
      () => {
        if (this.#services.get(definition.name) === record) record.state = "ready";
      },
      async (error: unknown) => {
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

  #serviceExited(record: ServiceRecord, result: ProcessResult): void {
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

  #connectionClosed(connection: DaemonConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
    for (const record of connection.references.values()) this.#release(connection, record);
    connection.references.clear();
    this.#scheduleIdleShutdown();
  }

  #release(connection: DaemonConnection, record: ServiceRecord): void {
    if (connection.references.get(record.definition.name) !== record) return;
    connection.references.delete(record.definition.name);
    record.connections.delete(connection);
    if (record.connections.size !== 0) return;
    if (this.#services.get(record.definition.name) !== record) return;

    this.#services.delete(record.definition.name);
    record.state = "stopping";
    void record.service[Symbol.asyncDispose]().finally(() => this.#scheduleIdleShutdown());
  }

  #scheduleIdleShutdown(): void {
    if (this.#closing || this.idleTimeout === null) return;
    clearTimeout(this.#idleTimer);
    if (this.#connections.size !== 0 || this.#services.size !== 0) return;
    this.#idleTimer = setTimeout(() => void this.close(), this.idleTimeout);
    this.#idleTimer.unref?.();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
