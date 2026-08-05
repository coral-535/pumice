export class PumiceError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
    this.code = options.code ?? "PUMICE_ERROR";
  }
}

export class ServiceConfigurationError extends PumiceError {
  constructor(service) {
    super(`service ${JSON.stringify(service)} is already running with a different definition`, {
      code: "SERVICE_CONFIGURATION_CONFLICT",
    });
    this.service = service;
  }
}

export class ServiceStartupError extends PumiceError {
  constructor(service, message, options = {}) {
    super(`service ${JSON.stringify(service)} failed to start: ${message}`, {
      cause: options.cause,
      code: "SERVICE_STARTUP_FAILED",
    });
    this.service = service;
  }
}

export class ServiceExitedError extends PumiceError {
  constructor({ service, generation, code = null, signal = null }) {
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
  constructor(message = "the Pumice daemon disconnected", options = {}) {
    super(message, { cause: options.cause, code: "DAEMON_DISCONNECTED" });
  }
}

export function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code,
    service: error?.service,
    generation: error?.generation,
    exitCode: error?.exitCode,
    signal: error?.signal,
  };
}

export function deserializeError(value) {
  if (!value || typeof value !== "object") {
    return new PumiceError(String(value));
  }
  switch (value.code) {
    case "SERVICE_CONFIGURATION_CONFLICT":
      return new ServiceConfigurationError(value.service);
    case "SERVICE_STARTUP_FAILED":
      return new ServiceStartupError(value.service, stripStartupPrefix(value));
    case "SERVICE_EXITED":
      return new ServiceExitedError({
        service: value.service,
        generation: value.generation,
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

function stripStartupPrefix(value) {
  const prefix = `service ${JSON.stringify(value.service)} failed to start: `;
  return value.message?.startsWith(prefix) ? value.message.slice(prefix.length) : value.message;
}
