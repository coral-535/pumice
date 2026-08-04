"use strict";

const SERVICE_DESCRIPTOR = Symbol.for("pumice.service");

function definePumice(options = {}) {
  assertPlainObject(options, "definePumice options");
  const ports = normalizePorts(options.ports ?? []);

  return Object.freeze({
    ports,
    service(serviceOptions) {
      assertPlainObject(serviceOptions, "service options");
      const command = requiredString(serviceOptions.command, "service command");
      const healthcheck = requiredString(serviceOptions.healthcheck, "service healthcheck");
      const healthcheckTimeout = normalizeTimeout(serviceOptions.healthcheckTimeout);
      const definition = Object.freeze({
        command,
        healthcheck,
        ports,
        ...(healthcheckTimeout === undefined ? {} : { healthcheckTimeout }),
      });

      const descriptor = {
        // A valid fallback keeps the descriptor task-shaped for tooling that
        // inspects it before Vite+'s JSON normalization pass.
        command: leaseCommand("service", definition),
        cache: false,
      };
      Object.defineProperty(descriptor, SERVICE_DESCRIPTOR, {
        configurable: false,
        enumerable: false,
        value: definition,
        writable: false,
      });
      Object.defineProperty(descriptor, "toJSON", {
        configurable: false,
        enumerable: false,
        value(taskName) {
          return materializeService(taskName, descriptor);
        },
        writable: false,
      });
      return Object.freeze(descriptor);
    },
  });
}

function isPumiceService(value) {
  return Boolean(value && typeof value === "object" && value[SERVICE_DESCRIPTOR]);
}

function normalizePumiceTasks(tasks) {
  assertPlainObject(tasks, "task map");
  return Object.fromEntries(
    Object.entries(tasks).map(([name, task]) => [
      name,
      isPumiceService(task) ? materializeService(name, task) : task,
    ]),
  );
}

function materializeService(taskName, descriptor) {
  const name = requiredString(taskName, "Pumice service task name");
  const definition = descriptor[SERVICE_DESCRIPTOR];
  if (!definition) {
    throw new TypeError("value is not a branded Pumice service descriptor");
  }
  return Object.freeze({
    command: leaseCommand(name, definition),
    cache: false,
  });
}

function leaseCommand(name, definition) {
  const encoded = Buffer.from(JSON.stringify(definition), "utf8").toString("base64url");
  return `pumice-internal lease --name ${shellQuote(name)} --definition ${encoded}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function normalizePorts(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("ports must be an array of environment variable names");
  }
  const seen = new Set();
  const ports = value.map((port) => {
    const name = requiredString(port, "port name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`port ${JSON.stringify(name)} is not a valid environment variable name`);
    }
    if (seen.has(name)) {
      throw new TypeError(`port ${JSON.stringify(name)} is declared more than once`);
    }
    seen.add(name);
    return name;
  });
  ports.sort();
  return Object.freeze(ports);
}

function normalizeTimeout(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("healthcheckTimeout must be a positive integer in milliseconds");
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

module.exports = {
  SERVICE_DESCRIPTOR,
  definePumice,
  isPumiceService,
  normalizePumiceTasks,
};
