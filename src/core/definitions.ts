import { createHash } from "node:crypto";
import type { StdioOptions } from "node:child_process";

export interface ServiceDefinition {
  name: string;
  command: string;
  healthcheck?: string;
  healthcheckTimeout?: number;
  healthcheckInterval?: number;
  dependsOn?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface Plan {
  services: ServiceDefinition[];
}

export interface NormalizedServiceDefinition {
  name: string;
  command: string;
  healthcheck: string | undefined;
  healthcheckTimeout: number;
  healthcheckInterval: number;
  dependsOn: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface NormalizedPlan {
  services: NormalizedServiceDefinition[];
}

export interface CommandDefinition {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: StdioOptions;
  terminationGracePeriod?: number;
}

export interface NormalizedCommandDefinition {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: StdioOptions;
  terminationGracePeriod: number;
}

export function normalizePlan(plan: unknown): NormalizedPlan {
  const services = Array.isArray(plan) ? plan : asRecord(plan)?.services;
  if (!Array.isArray(services)) {
    throw new TypeError("plan.services must be an array");
  }
  const normalized = services.map((definition: unknown) => normalizeServiceDefinition(definition));
  const byName = new Map<string, NormalizedServiceDefinition>();
  for (const definition of normalized) {
    if (byName.has(definition.name)) {
      throw new TypeError(`service ${JSON.stringify(definition.name)} occurs more than once`);
    }
    byName.set(definition.name, definition);
  }
  const ordered: NormalizedServiceDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (definition: NormalizedServiceDefinition) => {
    if (visited.has(definition.name)) return;
    if (visiting.has(definition.name)) {
      throw new TypeError(`service dependency graph contains a cycle at ${definition.name}`);
    }
    visiting.add(definition.name);
    for (const name of definition.dependsOn) {
      const dependency = byName.get(name);
      if (!dependency) {
        throw new TypeError(
          `service ${JSON.stringify(definition.name)} depends on unknown service ${JSON.stringify(name)}`,
        );
      }
      visit(dependency);
    }
    visiting.delete(definition.name);
    visited.add(definition.name);
    ordered.push(definition);
  };
  for (const definition of normalized) visit(definition);
  return { services: ordered };
}

export function normalizeServiceDefinition(definition: unknown): NormalizedServiceDefinition {
  const value = requireRecord(definition, "service definition");
  const name = requiredString(value.name, "service name");
  const command = requiredString(value.command, `command for service ${JSON.stringify(name)}`);
  const healthcheck = optionalString(value.healthcheck, "healthcheck");
  const healthcheckTimeout = value.healthcheckTimeout ?? 30_000;
  if (
    typeof healthcheckTimeout !== "number" ||
    !Number.isSafeInteger(healthcheckTimeout) ||
    healthcheckTimeout <= 0
  ) {
    throw new TypeError("healthcheckTimeout must be a positive integer in milliseconds");
  }
  const healthcheckInterval = value.healthcheckInterval ?? 100;
  if (
    typeof healthcheckInterval !== "number" ||
    !Number.isSafeInteger(healthcheckInterval) ||
    healthcheckInterval <= 0
  ) {
    throw new TypeError("healthcheckInterval must be a positive integer in milliseconds");
  }
  const dependsOn = normalizeStringArray(value.dependsOn, "dependsOn");
  const cwd = value.cwd === undefined ? process.cwd() : requiredString(value.cwd, "cwd");
  const env = normalizeEnvironment(value.env);
  return {
    name,
    command,
    healthcheck,
    healthcheckTimeout,
    healthcheckInterval,
    dependsOn,
    cwd,
    env,
  };
}

export function normalizeCommandDefinition(
  definition: string | CommandDefinition,
): NormalizedCommandDefinition {
  const value = requireRecord(
    typeof definition === "string" ? { command: definition } : definition,
    "command definition",
  );
  return {
    command: requiredString(value.command, "command"),
    cwd: value.cwd === undefined ? process.cwd() : requiredString(value.cwd, "cwd"),
    env: normalizeEnvironment(value.env),
    stdio: (value.stdio ?? "inherit") as StdioOptions,
    terminationGracePeriod: normalizeGracePeriod(value.terminationGracePeriod),
  };
}

export function definitionFingerprint(definition: NormalizedServiceDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: definition.command,
        healthcheck: definition.healthcheck,
        healthcheckTimeout: definition.healthcheckTimeout,
        healthcheckInterval: definition.healthcheckInterval,
        dependsOn: [...definition.dependsOn].sort(),
        cwd: definition.cwd,
        env: Object.entries(definition.env).sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest("hex");
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((item) => requiredString(item, `${label} entry`));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return result;
}

function normalizeEnvironment(value: unknown): Record<string, string | undefined> {
  if (value === undefined) return {};
  const environment = requireRecord(value, "env");
  return Object.fromEntries(
    Object.entries(environment).map(([key, item]) => {
      if (item === undefined) return [key, undefined];
      if (typeof item !== "string") {
        throw new TypeError(
          `environment value ${JSON.stringify(key)} must be a string or undefined`,
        );
      }
      return [key, item];
    }),
  );
}

function normalizeGracePeriod(value: unknown): number {
  if (value === undefined) return 5_000;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("terminationGracePeriod must be a non-negative integer in milliseconds");
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
