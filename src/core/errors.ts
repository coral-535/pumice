export interface PumiceErrorOptions extends ErrorOptions {
  code?: string;
}

export interface ServiceExit {
  service: string;
  generation: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

interface SerializedError {
  name: string;
  message: string;
  code?: string;
  service?: string;
  generation?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export class PumiceError extends Error {
  readonly code: string;

  constructor(message: string, options: PumiceErrorOptions = {}) {
    super(message, options);
    this.name = new.target.name;
    this.code = options.code ?? "PUMICE_ERROR";
  }
}

export class ServiceConfigurationError extends PumiceError {
  readonly service: string;

  constructor(service: string) {
    super(`service ${JSON.stringify(service)} is already running with a different definition`, {
      code: "SERVICE_CONFIGURATION_CONFLICT",
    });
    this.service = service;
  }
}

export class ServiceStartupError extends PumiceError {
  readonly service: string;

  constructor(service: string, message: string, options: ErrorOptions = {}) {
    super(`service ${JSON.stringify(service)} failed to start: ${message}`, {
      cause: options.cause,
      code: "SERVICE_STARTUP_FAILED",
    });
    this.service = service;
  }
}

export class ServiceExitedError extends PumiceError {
  readonly service: string;
  readonly generation: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor({ service, generation, code = null, signal = null }: ServiceExit) {
    const status = signal ? `signal ${signal}` : `exit code ${String(code)}`;
    super(`service ${JSON.stringify(service)} generation ${generation} exited with ${status}`, {
      code: "SERVICE_EXITED",
    });
    this.service = service;
    this.generation = generation;
    this.exitCode = code;
    this.signal = signal;
  }
}

export class DaemonDisconnectedError extends PumiceError {
  constructor(message = "the Pumice daemon disconnected", options: ErrorOptions = {}) {
    super(message, { cause: options.cause, code: "DAEMON_DISCONNECTED" });
  }
}

export function serializeError(error: unknown): SerializedError {
  const value = asRecord(error);
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: stringValue(value.code),
    service: stringValue(value.service),
    generation: numberValue(value.generation),
    exitCode: nullableNumberValue(value.exitCode),
    signal: stringValue(value.signal) as NodeJS.Signals | undefined,
  };
}

export function deserializeError(input: unknown): PumiceError {
  if (!input || typeof input !== "object") return new PumiceError(String(input));
  const value = input as Partial<SerializedError>;
  switch (value.code) {
    case "SERVICE_CONFIGURATION_CONFLICT":
      return new ServiceConfigurationError(value.service ?? "unknown");
    case "SERVICE_STARTUP_FAILED":
      return new ServiceStartupError(value.service ?? "unknown", stripStartupPrefix(value));
    case "SERVICE_EXITED":
      return new ServiceExitedError({
        service: value.service ?? "unknown",
        generation: value.generation ?? 0,
        code: value.exitCode,
        signal: value.signal,
      });
    case "DAEMON_DISCONNECTED":
      return new DaemonDisconnectedError(value.message);
    default: {
      const error = new PumiceError(value.message ?? "Pumice request failed", {
        code: value.code,
      });
      error.name = value.name ?? error.name;
      return error;
    }
  }
}

function stripStartupPrefix(value: Partial<SerializedError>): string {
  const prefix = `service ${JSON.stringify(value.service)} failed to start: `;
  return value.message?.startsWith(prefix)
    ? value.message.slice(prefix.length)
    : (value.message ?? "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nullableNumberValue(value: unknown): number | null | undefined {
  return value === null || typeof value === "number" ? value : undefined;
}
