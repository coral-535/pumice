import {
  normalizeCommandDefinition,
  type CommandDefinition,
  type NormalizedCommandDefinition,
} from "./definitions.ts";
import { ManagedProcess, type ProcessResult } from "./process.ts";

export interface StartCommandOptions {
  additionalArgs?: readonly string[];
}

export class RunningCommand implements AsyncDisposable {
  readonly definition: NormalizedCommandDefinition;
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;

  #process: ManagedProcess;

  constructor(definition: string | CommandDefinition, options: StartCommandOptions = {}) {
    this.definition = normalizeCommandDefinition(definition);
    this.#process = new ManagedProcess(this.definition.command, {
      cwd: this.definition.cwd,
      env: this.definition.env,
      stdio: this.definition.stdio,
      terminationGracePeriod: this.definition.terminationGracePeriod,
      additionalArgs: options.additionalArgs,
    });
    this.pid = this.#process.pid;
    this.exited = this.#process.exited;
  }

  terminate(signal: NodeJS.Signals = "SIGTERM"): Promise<ProcessResult> {
    return this.#process.terminate(signal);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.terminate();
  }
}

export function startCommand(
  definition: string | CommandDefinition,
  options?: StartCommandOptions,
): RunningCommand {
  return new RunningCommand(definition, options);
}
