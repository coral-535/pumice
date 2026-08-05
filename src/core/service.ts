import {
  normalizeServiceDefinition,
  type NormalizedServiceDefinition,
  type ServiceDefinition,
} from "./definitions.ts";
import { ServiceStartupError } from "./errors.ts";
import { ManagedProcess, sleep, type ProcessResult } from "./process.ts";

const HEALTHCHECK_INTERVAL = 100;

type HealthcheckOutcome =
  | { type: "check"; result: ProcessResult }
  | { type: "service"; result: ProcessResult }
  | { type: "timeout" };

export class Service implements AsyncDisposable {
  readonly definition: NormalizedServiceDefinition;
  readonly key: string;
  readonly generation: number;
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;

  #process: ManagedProcess;

  constructor(definition: NormalizedServiceDefinition, generation: number) {
    this.definition = definition;
    this.key = definition.name;
    this.generation = generation;
    this.#process = new ManagedProcess(definition.command, {
      cwd: definition.cwd,
      env: definition.env,
      stdio: "ignore",
    });
    this.pid = this.#process.pid;
    this.exited = this.#process.exited;
  }

  static start(
    definition: ServiceDefinition | NormalizedServiceDefinition,
    generation: number,
  ): Service {
    return new Service(normalizeServiceDefinition(definition), generation);
  }

  async waitUntilHealthy(): Promise<void> {
    try {
      await this.#process.spawned;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ServiceStartupError(this.key, cause.message, { cause });
    }
    if (!this.definition.healthcheck) {
      await ensureStillRunning(this);
      return;
    }

    const deadline = Date.now() + this.definition.healthcheckTimeout;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const check = new ManagedProcess(this.definition.healthcheck, {
        cwd: this.definition.cwd,
        env: this.definition.env,
        stdio: "ignore",
        terminationGracePeriod: Math.min(1_000, remaining),
      });
      const outcome: HealthcheckOutcome = await Promise.race([
        check.exited.then((result) => ({ type: "check" as const, result })),
        this.exited.then((result) => ({ type: "service" as const, result })),
        sleep(remaining).then(() => ({ type: "timeout" as const })),
      ]);

      if (outcome.type === "service") {
        await check[Symbol.asyncDispose]();
        throw exitedDuringStartup(this.key, outcome.result);
      }
      if (outcome.type === "timeout") {
        await check[Symbol.asyncDispose]();
        break;
      }
      if (outcome.result.code === 0 && !outcome.result.error) return;

      await sleep(Math.min(HEALTHCHECK_INTERVAL, Math.max(0, deadline - Date.now())));
    }

    throw new ServiceStartupError(
      this.key,
      `healthcheck did not succeed within ${this.definition.healthcheckTimeout}ms`,
    );
  }

  terminate(): Promise<ProcessResult> {
    return this.#process.terminate();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.terminate();
  }
}

async function ensureStillRunning(service: Service): Promise<void> {
  const marker = Symbol("running");
  const outcome = await Promise.race([service.exited, Promise.resolve(marker)]);
  if (outcome !== marker) throw exitedDuringStartup(service.key, outcome);
}

function exitedDuringStartup(service: string, result: ProcessResult): ServiceStartupError {
  if (result.error) {
    return new ServiceStartupError(service, result.error.message, { cause: result.error });
  }
  const status = result.signal ? `signal ${result.signal}` : `exit code ${String(result.code)}`;
  return new ServiceStartupError(service, `process exited with ${status}`);
}
