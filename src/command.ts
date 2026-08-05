import {
  normalizeCommandDefinition,
  type CommandDefinition,
  type NormalizedCommandDefinition,
} from "./definitions.ts";
import { ManagedProcess, type ProcessResult } from "./process.ts";

export class RunningCommand implements AsyncDisposable {
  readonly definition: NormalizedCommandDefinition;
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;

  #process: ManagedProcess;

  constructor(definition: string | CommandDefinition) {
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

  terminate(): Promise<ProcessResult> {
    return this.#process.terminate();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.terminate();
  }
}

export function startCommand(definition: string | CommandDefinition): RunningCommand {
  return new RunningCommand(definition);
}
