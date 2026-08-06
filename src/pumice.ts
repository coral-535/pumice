import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_VERSION,
  canonicalWorkspaceRoot,
  type CompiledCommand,
  type CompiledManifest,
  type CompiledService,
  type ManifestScope,
  writeManifest,
} from "./manifest.ts";

export interface PumiceServiceDefinition {
  command: string;
  healthcheck?: string;
  healthcheckTimeout?: number;
  healthcheckInterval?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  ports?: string[];
  dependsOn?: string[];
}

export interface NamedPumiceServiceDefinition extends PumiceServiceDefinition {
  name: string;
}

export interface PumiceConfiguration {
  workspaceRoot?: string;
  cacheDirectory?: string;
  scope?: ManifestScope;
  ports?: string[];
  env?: Record<string, string | undefined>;
  services?: Record<string, PumiceServiceDefinition>;
}

export interface PumiceCommandDefinition {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  [option: string]: unknown;
}

export interface ViteTaskDefinition {
  command: string;
  cache: boolean;
  [option: string]: unknown;
}

export interface CompileTaskOptions {
  workspaceRoot?: string;
  cacheDirectory?: string;
  runnerPath?: string;
}

export interface PumiceServiceHandle {
  readonly name: string;
  service(definition: NamedPumiceServiceDefinition): PumiceServiceHandle;
  task(
    definition: string | PumiceCommandDefinition,
    options?: CompileTaskOptions,
  ): ViteTaskDefinition;
  manifest(
    definition: string | PumiceCommandDefinition,
    options?: CompileTaskOptions,
  ): CompiledManifest;
}

export interface Pumice {
  service(name: string): PumiceServiceHandle;
}

interface InternalConfiguration {
  workspaceRoot: string;
  cacheDirectory: string;
  scope: ManifestScope;
  ports: string[];
  env: Record<string, string | undefined>;
  services: Map<string, PumiceServiceDefinition>;
}

export function definePumice(configuration: PumiceConfiguration = {}): Pumice {
  const workspaceRoot = canonicalWorkspaceRoot(configuration.workspaceRoot ?? process.cwd());
  const internal: InternalConfiguration = {
    workspaceRoot,
    cacheDirectory: resolve(
      configuration.cacheDirectory ?? join(workspaceRoot, "node_modules", ".cache", "pumice"),
    ),
    scope: configuration.scope ?? resolveWorktreeScope(workspaceRoot),
    ports: normalizeNames(configuration.ports, "ports"),
    env: { ...configuration.env },
    services: new Map(),
  };
  for (const [name, service] of Object.entries(configuration.services ?? {})) {
    registerService(internal, name, service);
  }
  return {
    service(name) {
      if (!internal.services.has(name)) {
        throw new TypeError(`unknown Pumice service ${JSON.stringify(name)}`);
      }
      return createServiceHandle(internal, name, []);
    },
  };
}

export function compileManifest(
  configuration: PumiceConfiguration,
  serviceName: string,
  command: string | PumiceCommandDefinition,
  options: CompileTaskOptions = {},
): CompiledManifest {
  const pumice = definePumice({ ...configuration, workspaceRoot: options.workspaceRoot });
  return pumice.service(serviceName).manifest(command, options);
}

export function resolveViteTaskRunner(): string {
  const source = import.meta.url.endsWith(".ts");
  return fileURLToPath(
    new URL(source ? "./vite-task-runner.ts" : "./vite-task-runner.mjs", import.meta.url),
  );
}

function createServiceHandle(
  configuration: InternalConfiguration,
  name: string,
  ancestors: string[],
): PumiceServiceHandle {
  const chain = [...ancestors, name];
  return {
    name,
    service(definition) {
      const dependencies = unique([...chain, ...(definition.dependsOn ?? [])]);
      registerService(configuration, definition.name, { ...definition, dependsOn: dependencies });
      return createServiceHandle(configuration, definition.name, chain);
    },
    task(definition, options = {}) {
      const manifest = compileFromHandle(configuration, chain, definition, options);
      const cacheDirectory = resolve(options.cacheDirectory ?? configuration.cacheDirectory);
      const manifestPath = writeManifest(cacheDirectory, manifest);
      const runnerPath = resolve(options.runnerPath ?? resolveViteTaskRunner());
      if (!isAbsolute(runnerPath)) throw new TypeError("Pumice runner path must be absolute");
      const input = normalizeCommandInput(definition);
      const {
        command: _command,
        cwd: _cwd,
        env: _env,
        cache: requestedCache,
        ...taskOptions
      } = input;
      return {
        ...taskOptions,
        command: `node ${shellQuote(runnerPath)} ${shellQuote(manifestPath)}`,
        cache: requestedCache === undefined ? false : Boolean(requestedCache),
      };
    },
    manifest(definition, options = {}) {
      return compileFromHandle(configuration, chain, definition, options);
    },
  };
}

function compileFromHandle(
  configuration: InternalConfiguration,
  chain: string[],
  commandInput: string | PumiceCommandDefinition,
  options: CompileTaskOptions,
): CompiledManifest {
  const workspaceRoot = options.workspaceRoot
    ? canonicalWorkspaceRoot(options.workspaceRoot)
    : configuration.workspaceRoot;
  const requiredNames = collectServiceClosure(configuration.services, chain);
  const portNames = unique([
    ...configuration.ports,
    ...requiredNames.flatMap((name) => configuration.services.get(name)?.ports ?? []),
  ]);
  const allocatedPorts = allocatePorts(configuration.scope.id, portNames);
  const baseEnvironment = concreteEnvironment(configuration.env);
  for (const name of configuration.ports) baseEnvironment[name] = allocatedPorts[name]!;
  const serviceEnvironments = new Map<string, Record<string, string>>();
  const services: CompiledService[] = requiredNames.map((name) => {
    const definition = configuration.services.get(name)!;
    const environment = { ...baseEnvironment };
    for (const dependency of definition.dependsOn ?? []) {
      Object.assign(environment, serviceEnvironments.get(dependency));
    }
    for (const portName of definition.ports ?? []) {
      environment[portName] = allocatedPorts[portName]!;
    }
    Object.assign(environment, concreteEnvironment(definition.env));
    serviceEnvironments.set(name, environment);
    return {
      name,
      command: interpolate(definition.command, environment),
      cwd: resolveWorkspacePath(workspaceRoot, definition.cwd),
      env: environment,
      healthcheck: definition.healthcheck
        ? {
            command: interpolate(definition.healthcheck, environment),
            timeoutMs: positiveInteger(
              definition.healthcheckTimeout ?? 30_000,
              "healthcheckTimeout",
            ),
            intervalMs: positiveInteger(
              definition.healthcheckInterval ?? 250,
              "healthcheckInterval",
            ),
          }
        : null,
      dependsOn: unique(definition.dependsOn ?? []).filter((dependency) =>
        requiredNames.includes(dependency),
      ),
    };
  });
  const commandDefinition = normalizeCommandInput(commandInput);
  const commandEnvironment = {
    ...baseEnvironment,
    ...Object.fromEntries(
      requiredNames.flatMap((name) => Object.entries(serviceEnvironments.get(name) ?? {})),
    ),
    ...concreteEnvironment(commandDefinition.env as Record<string, string | undefined> | undefined),
  };
  const command: CompiledCommand = {
    command: interpolate(commandDefinition.command, commandEnvironment),
    cwd: resolveWorkspacePath(workspaceRoot, commandDefinition.cwd as string | undefined),
    env: commandEnvironment,
  };
  return {
    version: MANIFEST_VERSION,
    workspaceRoot,
    scope: configuration.scope,
    services,
    command,
  };
}

function registerService(
  configuration: InternalConfiguration,
  name: string,
  definition: PumiceServiceDefinition,
): void {
  requireName(name, "service name");
  if (configuration.services.has(name)) {
    throw new TypeError(`Pumice service ${JSON.stringify(name)} is already defined`);
  }
  if (!definition || typeof definition !== "object") {
    throw new TypeError(`definition for Pumice service ${JSON.stringify(name)} must be an object`);
  }
  requireCommand(definition.command, `command for Pumice service ${JSON.stringify(name)}`);
  configuration.services.set(name, {
    ...definition,
    ports: normalizeNames(definition.ports, `ports for service ${JSON.stringify(name)}`),
    dependsOn: normalizeNames(
      definition.dependsOn,
      `dependsOn for service ${JSON.stringify(name)}`,
    ),
  });
}

function collectServiceClosure(
  services: Map<string, PumiceServiceDefinition>,
  roots: string[],
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new TypeError(`Pumice service graph contains a cycle at ${name}`);
    const definition = services.get(name);
    if (!definition)
      throw new TypeError(`unknown Pumice service dependency ${JSON.stringify(name)}`);
    visiting.add(name);
    for (const dependency of definition.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  };
  for (const root of roots) visit(root);
  return result;
}

function allocatePorts(scopeId: string, names: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<number>();
  for (const name of names) {
    const provided = process.env[name];
    if (provided !== undefined) {
      const port = portNumber(provided, name);
      if (used.has(port)) throw new TypeError(`Pumice port ${port} is assigned more than once`);
      used.add(port);
      result[name] = String(port);
      continue;
    }
    const digest = createHash("sha256").update(`${scopeId}\0${name}`).digest();
    let port = 49_152 + (digest.readUInt16BE(0) % (65_535 - 49_152 + 1));
    while (used.has(port)) port = port === 65_535 ? 49_152 : port + 1;
    used.add(port);
    result[name] = String(port);
  }
  return result;
}

function resolveWorktreeScope(workspaceRoot: string): ManifestScope {
  try {
    const commonInput = execFileSync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const commonPath = resolve(workspaceRoot, commonInput);
    const commonDirectory = existsSync(commonPath) ? realpathSync(commonPath) : commonPath;
    return {
      type: "worktree",
      id: `git-common-dir:${commonDirectory}|worktree:${workspaceRoot}`,
    };
  } catch {
    return { type: "worktree", id: `worktree:${workspaceRoot}` };
  }
}

function normalizeCommandInput(input: string | PumiceCommandDefinition): PumiceCommandDefinition {
  const definition = typeof input === "string" ? { command: input } : input;
  if (!definition || typeof definition !== "object") {
    throw new TypeError("Pumice command definition must be a string or object");
  }
  requireCommand(definition.command, "Pumice command");
  return definition;
}

function concreteEnvironment(
  input: Record<string, string | undefined> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      if (value === undefined) return false;
      if (typeof value !== "string")
        throw new TypeError("Pumice environment values must be strings");
      return true;
    }),
  );
}

function interpolate(command: string, environment: Record<string, string>): string {
  return command.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced, plain) => {
      const value = environment[String(braced ?? plain)];
      return value === undefined ? match : value;
    },
  );
}

function resolveWorkspacePath(workspaceRoot: string, input: string | undefined): string {
  return input === undefined ? workspaceRoot : resolve(workspaceRoot, input);
}

function normalizeNames(input: string[] | undefined, label: string): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  const names = input.map((name) => requireName(name, `${label} entry`));
  if (new Set(names).size !== names.length)
    throw new TypeError(`${label} must not contain duplicates`);
  return names;
}

function requireName(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(input)) {
    throw new TypeError(`${label} must be a non-empty identifier`);
  }
  return input;
}

function requireCommand(input: unknown, label: string): asserts input is string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function portNumber(input: string, name: string): number {
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError(`environment variable ${name} must contain a valid TCP port`);
  }
  return port;
}

function positiveInteger(input: number, label: string): number {
  if (!Number.isSafeInteger(input) || input <= 0) throw new TypeError(`${label} must be positive`);
  return input;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shellQuote(input: string): string {
  if (process.platform === "win32") return `"${input.replaceAll('"', '\\"')}"`;
  return `'${input.replaceAll("'", `'"'"'`)}'`;
}
