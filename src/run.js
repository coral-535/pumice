import { startCommand } from "./command.js";
import { ServiceGuard } from "./service-guard.js";

export async function run(worktreePath, plan, commandDefinition, options) {
  await using guard = await ServiceGuard.connect(worktreePath, options);
  await guard.run(plan);

  await using command = startCommand(commandDefinition);
  const outcome = await Promise.race([
    command.exited.then((result) => ({ type: "command", result })),
    guard.failure.then((error) => ({ type: "guard", error })),
  ]);

  if (outcome.type === "guard") throw outcome.error;
  return outcome.result;
}
