import { normalizeCommandDefinition } from "./definitions.js";
import { ManagedProcess } from "./process.js";

export class RunningCommand {
  #process;

  constructor(definition) {
    this.definition = normalizeCommandDefinition(definition);
    this.#process = new ManagedProcess(this.definition.command, {
      cwd: this.definition.cwd,
      env: this.definition.env,
      stdio: this.definition.stdio,
      terminationGracePeriod: this.definition.terminationGracePeriod,
    });
    this.pid = this.#process.pid;
    this.exited = this.#process.exited;
  }

  terminate() {
    return this.#process.terminate();
  }

  async [Symbol.asyncDispose]() {
    await this.terminate();
  }
}

export function startCommand(definition) {
  return new RunningCommand(definition);
}
