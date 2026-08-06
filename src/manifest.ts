import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, basename, dirname, join, resolve } from "node:path";

export const MANIFEST_VERSION = 1 as const;

export interface ManifestScope {
  type: "worktree" | "repository" | "global";
  id: string;
}

export interface ManifestHealthcheck {
  command: string;
  timeoutMs: number;
  intervalMs: number;
}

export interface CompiledService {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  healthcheck: ManifestHealthcheck | null;
  dependsOn: string[];
}

export interface CompiledCommand {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

export interface CompiledManifest {
  version: typeof MANIFEST_VERSION;
  workspaceRoot: string;
  scope: ManifestScope;
  services: CompiledService[];
  command: CompiledCommand;
}

export function stableStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (input: unknown): string => {
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("manifest numbers must be finite");
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) {
      if (ancestors.has(input)) throw new TypeError("manifest must not contain cycles");
      ancestors.add(input);
      const result = `[${input.map((item) => serialize(item)).join(",")}]`;
      ancestors.delete(input);
      return result;
    }
    if (input && typeof input === "object") {
      if (ancestors.has(input)) throw new TypeError("manifest must not contain cycles");
      ancestors.add(input);
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`);
      ancestors.delete(input);
      return `{${entries.join(",")}}`;
    }
    throw new TypeError(`manifest cannot contain ${typeof input} values`);
  };
  return serialize(value);
}

export function manifestHash(manifestOrJson: CompiledManifest | string): string {
  const json =
    typeof manifestOrJson === "string" ? manifestOrJson : stableStringify(manifestOrJson);
  return createHash("sha256").update(json).digest("hex");
}

export function writeManifest(cacheDirectory: string, manifest: CompiledManifest): string {
  validateManifest(manifest);
  const json = stableStringify(manifest);
  const path = join(resolve(cacheDirectory), "manifests", `${manifestHash(json)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== json) {
      throw new Error(`Pumice manifest hash collision at ${path}`);
    }
  }
  return path;
}

export function readAndValidateManifest(path: string): CompiledManifest {
  if (!isAbsolute(path)) throw new TypeError("Pumice manifest path must be absolute");
  const json = readFileSync(path, "utf8");
  const expectedName = `${manifestHash(json)}.json`;
  if (basename(path) !== expectedName) {
    throw new TypeError(
      `Pumice manifest content hash does not match filename (expected ${expectedName})`,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (error) {
    throw new TypeError(`Pumice manifest is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return validateManifest(input);
}

export function validateManifest(input: unknown): CompiledManifest {
  const manifest = record(input, "manifest");
  if (manifest.version !== MANIFEST_VERSION) {
    throw new TypeError(`unsupported Pumice manifest version ${JSON.stringify(manifest.version)}`);
  }
  const workspaceRoot = absolutePath(manifest.workspaceRoot, "manifest.workspaceRoot");
  const scopeInput = record(manifest.scope, "manifest.scope");
  const scopeType = requiredString(scopeInput.type, "manifest.scope.type");
  if (scopeType !== "worktree" && scopeType !== "repository" && scopeType !== "global") {
    throw new TypeError(`unsupported Pumice scope type ${JSON.stringify(scopeType)}`);
  }
  const scope: ManifestScope = {
    type: scopeType,
    id: requiredString(scopeInput.id, "manifest.scope.id"),
  };
  if (!Array.isArray(manifest.services)) {
    throw new TypeError("manifest.services must be an array");
  }
  const services = manifest.services.map((service, index) =>
    validateService(service, `manifest.services[${index}]`),
  );
  validateServiceGraph(services);
  const commandInput = record(manifest.command, "manifest.command");
  const command: CompiledCommand = {
    command: requiredString(commandInput.command, "manifest.command.command"),
    cwd: absolutePath(commandInput.cwd, "manifest.command.cwd"),
    env: stringEnvironment(commandInput.env, "manifest.command.env"),
  };
  return { version: MANIFEST_VERSION, workspaceRoot, scope, services, command };
}

function validateService(input: unknown, label: string): CompiledService {
  const service = record(input, label);
  const healthcheckInput = service.healthcheck;
  let healthcheck: ManifestHealthcheck | null = null;
  if (healthcheckInput !== null && healthcheckInput !== undefined) {
    const check = record(healthcheckInput, `${label}.healthcheck`);
    healthcheck = {
      command: requiredString(check.command, `${label}.healthcheck.command`),
      timeoutMs: positiveInteger(check.timeoutMs, `${label}.healthcheck.timeoutMs`),
      intervalMs: positiveInteger(check.intervalMs, `${label}.healthcheck.intervalMs`),
    };
  }
  return {
    name: requiredString(service.name, `${label}.name`),
    command: requiredString(service.command, `${label}.command`),
    cwd: absolutePath(service.cwd, `${label}.cwd`),
    env: stringEnvironment(service.env, `${label}.env`),
    healthcheck,
    dependsOn: stringArray(service.dependsOn, `${label}.dependsOn`),
  };
}

function validateServiceGraph(services: CompiledService[]): void {
  const positions = new Map(services.map((service, index) => [service.name, index]));
  if (positions.size !== services.length) throw new TypeError("service names must be unique");
  for (const [index, service] of services.entries()) {
    for (const dependency of service.dependsOn) {
      const dependencyIndex = positions.get(dependency);
      if (dependencyIndex === undefined) {
        throw new TypeError(
          `service ${JSON.stringify(service.name)} depends on unknown service ${JSON.stringify(dependency)}`,
        );
      }
      if (dependencyIndex >= index) {
        throw new TypeError(
          `service ${JSON.stringify(service.name)} must appear after dependency ${JSON.stringify(dependency)}`,
        );
      }
    }
  }
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return input;
}

function absolutePath(input: unknown, label: string): string {
  const path = requiredString(input, label);
  if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
  return path;
}

function positiveInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return input;
}

function stringEnvironment(input: unknown, label: string): Record<string, string> {
  const environment = record(input, label);
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => {
      if (typeof value !== "string") throw new TypeError(`${label}.${name} must be a string`);
      return [name, value];
    }),
  );
}

function stringArray(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  const result = input.map((item) => requiredString(item, `${label} entry`));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function canonicalWorkspaceRoot(path: string): string {
  return realpathSync(resolve(path));
}
