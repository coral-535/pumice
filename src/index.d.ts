/// <reference types="node" />

import type { StdioOptions } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

export interface ServiceDefinition {
  name: string;
  command: string;
  healthcheck?: string;
  healthcheckTimeout?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface Plan {
  services: ServiceDefinition[];
}

export interface CommandDefinition {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: StdioOptions;
  terminationGracePeriod?: number;
}

export interface AcquiredPlan {
  services: Array<{ name: string; generation: number }>;
}

export type DaemonEvent =
  | {
      type: "service-exited";
      service: string;
      generation: number;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | { type: "daemon-disconnected" };

export class RunningCommand implements AsyncDisposable {
  constructor(definition: string | CommandDefinition);
  readonly definition: Required<Omit<CommandDefinition, "env">> & {
    env: Record<string, string | undefined>;
  };
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;
  terminate(): Promise<ProcessResult>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function startCommand(definition: string | CommandDefinition): RunningCommand;

export interface ServiceGuardOptions {
  socketPath?: string;
  lockPath?: string;
  connectTimeout?: number;
  startDaemon?: boolean;
  daemonEntry?: string;
}

export class ServiceGuard implements AsyncDisposable {
  static connect(worktreePath?: string, options?: ServiceGuardOptions): Promise<ServiceGuard>;
  readonly failure: Promise<DaemonDisconnectedError | ServiceExitedError>;
  run(plan: Plan | ServiceDefinition[]): Promise<AcquiredPlan>;
  onEvent(listener: (event: DaemonEvent) => void): Disposable;
  [Symbol.asyncDispose](): Promise<void>;
}

export class Service implements AsyncDisposable {
  static start(definition: ServiceDefinition, generation: number): Service;
  readonly key: string;
  readonly generation: number;
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;
  waitUntilHealthy(): Promise<void>;
  terminate(): Promise<ProcessResult>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface DaemonServerOptions {
  socketPath: string;
  idleTimeout?: number | null;
}

export class DaemonServer {
  constructor(options: DaemonServerOptions);
  readonly socketPath: string;
  readonly idleTimeout: number | null;
  readonly serviceCount: number;
  readonly connectionCount: number;
  readonly closed: Promise<void>;
  listen(): Promise<this>;
  close(): Promise<void>;
}

export function run(
  worktreePath: string,
  plan: Plan | ServiceDefinition[],
  commandDefinition: string | CommandDefinition,
  options?: ServiceGuardOptions,
): Promise<ProcessResult>;

export class PumiceError extends Error {
  readonly code: string;
}

export class ServiceConfigurationError extends PumiceError {
  readonly service: string;
}

export class ServiceStartupError extends PumiceError {
  readonly service: string;
}

export class ServiceExitedError extends PumiceError {
  readonly service: string;
  readonly generation: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class DaemonDisconnectedError extends PumiceError {}
