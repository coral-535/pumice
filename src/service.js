import { ServiceStartupError } from "./errors.js";
import { normalizeServiceDefinition } from "./definitions.js";
import { ManagedProcess, sleep } from "./process.js";

const HEALTHCHECK_INTERVAL = 100;

export class Service {
  #process;

  constructor(definition, generation) {
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

  static start(definition, generation) {
    return new Service(normalizeServiceDefinition(definition), generation);
  }

  async waitUntilHealthy() {
    try {
      await this.#process.spawned;
    } catch (error) {
      throw new ServiceStartupError(this.key, error.message, { cause: error });
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
      const outcome = await Promise.race([
        check.exited.then((result) => ({ type: "check", result })),
        this.exited.then((result) => ({ type: "service", result })),
        sleep(remaining).then(() => ({ type: "timeout" })),
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

  terminate() {
    return this.#process.terminate();
  }

  async [Symbol.asyncDispose]() {
    await this.terminate();
  }
}

async function ensureStillRunning(service) {
  const marker = Symbol("running");
  const outcome = await Promise.race([
    service.exited,
    Promise.resolve(marker),
  ]);
  if (outcome !== marker) throw exitedDuringStartup(service.key, outcome);
}

function exitedDuringStartup(service, result) {
  if (result.error) {
    return new ServiceStartupError(service, result.error.message, { cause: result.error });
  }
  const status = result.signal ? `signal ${result.signal}` : `exit code ${String(result.code)}`;
  return new ServiceStartupError(service, `process exited with ${status}`);
}
