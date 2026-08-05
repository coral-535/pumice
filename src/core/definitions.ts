import { createHash } from "node:crypto";
import type { StdioOptions } from "node:child_process";

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

export interface NormalizedServiceDefinition {
  name: string;
  command: string;
  healthcheck: string | undefined;
  healthcheckTimeout: number;
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
  const seen = new Set<string>();
  return {
    services: services.map((definition: unknown) => {
      const normalized = normalizeServiceDefinition(definition);
      if (seen.has(normalized.name)) {
        throw new TypeError(`service ${JSON.stringify(normalized.name)} occurs more than once`);
      }
      seen.add(normalized.name);
      return normalized;
    }),
  };
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
  const cwd = value.cwd === undefined ? process.cwd() : requiredString(value.cwd, "cwd");
  const env = normalizeEnvironment(value.env);
  return { name, command, healthcheck, healthcheckTimeout, cwd, env };
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
        cwd: definition.cwd,
        env: Object.entries(definition.env).sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest("hex");
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
