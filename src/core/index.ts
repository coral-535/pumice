export { RunningCommand, startCommand, type StartCommandOptions } from "./command.ts";
export { DaemonServer, type AcquiredPlan, type DaemonServerOptions } from "./daemon.ts";
export type { CommandDefinition, Plan, ServiceDefinition } from "./definitions.ts";
export {
  DaemonDisconnectedError,
  PumiceError,
  ServiceConfigurationError,
  ServiceExitedError,
  ServiceStartupError,
} from "./errors.ts";
export { run } from "./run.ts";
export { Service } from "./service.ts";
export type { ProcessResult } from "./process.ts";
export {
  ServiceGuard,
  TASK_SCOPED_ENVIRONMENT_VARIABLES,
  daemonEnvironment,
  type DaemonEvent,
  type ServiceGuardOptions,
} from "./service-guard.ts";
