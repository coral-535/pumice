export interface PumiceOptions {
  /** Worktree-scoped random ports delivered as environment variables. */
  ports?: readonly string[];
}

export interface ServiceOptions {
  /** Foreground command for the long-running service. */
  command: string;
  /** Command retried until it exits successfully. */
  healthcheck: string;
  /** Readiness timeout in milliseconds. Defaults to 30 seconds. */
  healthcheckTimeout?: number;
}

export interface ViteTaskDefinition {
  readonly command: string;
  readonly cache: false;
}

export interface PumiceServiceDescriptor extends ViteTaskDefinition {
  readonly [SERVICE_DESCRIPTOR]: Readonly<{
    command: string;
    healthcheck: string;
    ports: readonly string[];
    healthcheckTimeout?: number;
  }>;
  toJSON(taskName: string): ViteTaskDefinition;
}

export interface Pumice {
  readonly ports: readonly string[];
  service(options: ServiceOptions): PumiceServiceDescriptor;
}

export declare const SERVICE_DESCRIPTOR: unique symbol;
export declare function definePumice(options?: PumiceOptions): Pumice;
export declare function isPumiceService(value: unknown): value is PumiceServiceDescriptor;
export declare function normalizePumiceTasks<T extends Record<string, unknown>>(
  tasks: T,
): { [K in keyof T]: T[K] extends PumiceServiceDescriptor ? ViteTaskDefinition : T[K] };
