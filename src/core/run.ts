import { startCommand } from "./command.ts";
import type { CommandDefinition, Plan, ServiceDefinition } from "./definitions.ts";
import type { ProcessResult } from "./process.ts";
import { ServiceGuard, type ServiceGuardOptions } from "./service-guard.ts";

export async function run(
  worktreePath: string,
  plan: Plan | ServiceDefinition[],
  commandDefinition: string | CommandDefinition,
  options?: ServiceGuardOptions,
): Promise<ProcessResult> {
  await using guard = await ServiceGuard.connect(worktreePath, options);
  await guard.run(plan);

  await using command = startCommand(commandDefinition);
  const outcome = await Promise.race([
    command.exited.then((result) => ({ type: "command" as const, result })),
    guard.failure.then((error) => ({ type: "guard" as const, error })),
  ]);

  if (outcome.type === "guard") throw outcome.error;
  return outcome.result;
}
