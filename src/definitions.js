import { createHash } from "node:crypto";

export function normalizePlan(plan) {
  const services = Array.isArray(plan) ? plan : plan?.services;
  if (!Array.isArray(services)) {
    throw new TypeError("plan.services must be an array");
  }
  const seen = new Set();
  return {
    services: services.map((definition) => {
      const normalized = normalizeServiceDefinition(definition);
      if (seen.has(normalized.name)) {
        throw new TypeError(`service ${JSON.stringify(normalized.name)} occurs more than once`);
      }
      seen.add(normalized.name);
      return normalized;
    }),
  };
}

export function normalizeServiceDefinition(definition) {
  assertObject(definition, "service definition");
  const name = requiredString(definition.name, "service name");
  const command = requiredString(definition.command, `command for service ${JSON.stringify(name)}`);
  const healthcheck = optionalString(definition.healthcheck, "healthcheck");
  const healthcheckTimeout = definition.healthcheckTimeout ?? 30_000;
  if (!Number.isSafeInteger(healthcheckTimeout) || healthcheckTimeout <= 0) {
    throw new TypeError("healthcheckTimeout must be a positive integer in milliseconds");
  }
  const cwd = definition.cwd === undefined ? process.cwd() : requiredString(definition.cwd, "cwd");
  const env = normalizeEnvironment(definition.env);
  return { name, command, healthcheck, healthcheckTimeout, cwd, env };
}

export function normalizeCommandDefinition(definition) {
  if (typeof definition === "string") {
    definition = { command: definition };
  }
  assertObject(definition, "command definition");
  return {
    command: requiredString(definition.command, "command"),
    cwd: definition.cwd === undefined ? process.cwd() : requiredString(definition.cwd, "cwd"),
    env: normalizeEnvironment(definition.env),
    stdio: definition.stdio ?? "inherit",
    terminationGracePeriod: normalizeGracePeriod(definition.terminationGracePeriod),
  };
}

export function definitionFingerprint(definition) {
  return createHash("sha256")
    .update(JSON.stringify({
      command: definition.command,
      healthcheck: definition.healthcheck,
      healthcheckTimeout: definition.healthcheckTimeout,
      cwd: definition.cwd,
      env: Object.entries(definition.env).sort(([a], [b]) => a.localeCompare(b)),
    }))
    .digest("hex");
}

function normalizeEnvironment(value) {
  if (value === undefined) return {};
  assertObject(value, "env");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (item === undefined) return [key, undefined];
    if (typeof item !== "string") {
      throw new TypeError(`environment value ${JSON.stringify(key)} must be a string or undefined`);
    }
    return [key, item];
  }));
}

function normalizeGracePeriod(value) {
  if (value === undefined) return 5_000;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("terminationGracePeriod must be a non-negative integer in milliseconds");
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}
