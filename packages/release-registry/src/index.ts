import { isProductRouteVersion } from "../../replay-core/src/route-version.ts";

export const RELEASE_REGISTRY_SCHEMA_VERSION = 1;

export interface PlayerReleaseArtifact {
  r2Prefix: string;
  sha256: string;
  builtAt: string;
}

export interface WorkerReleaseArtifact {
  serviceName: string;
  bindingName: string;
  sourceCommit: string;
}

export interface ReleaseEntry {
  version: string;
  sourceCommit: string;
  player: PlayerReleaseArtifact;
  worker: WorkerReleaseArtifact;
}

export interface ReleaseRegistry {
  schemaVersion: number;
  releases: ReleaseEntry[];
}

export class ReleaseRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRegistryError";
  }
}

export function parseReleaseRegistry(input: unknown): ReleaseRegistry {
  const raw = parseUnknown(input);
  if (!isRecord(raw)) {
    throw new ReleaseRegistryError("Release registry must be an object.");
  }
  if (raw.schemaVersion !== RELEASE_REGISTRY_SCHEMA_VERSION) {
    throw new ReleaseRegistryError(
      `Unsupported release registry schema version: ${String(raw.schemaVersion)}.`,
    );
  }
  if (!Array.isArray(raw.releases)) {
    throw new ReleaseRegistryError("Release registry releases must be an array.");
  }

  const releases = raw.releases.map((entry, index) => parseReleaseEntry(entry, index));
  const versions = new Set<string>();
  for (const entry of releases) {
    if (versions.has(entry.version)) {
      throw new ReleaseRegistryError(
        `Release registry contains duplicate version ${entry.version}.`,
      );
    }
    versions.add(entry.version);
  }

  return { schemaVersion: RELEASE_REGISTRY_SCHEMA_VERSION, releases };
}

/** Existing release records are immutable; new entries may only be appended. */
export function assertAppendOnlyReleaseRegistry(
  previousInput: unknown,
  nextInput: unknown,
): ReleaseRegistry {
  const previous = parseReleaseRegistry(previousInput);
  const next = parseReleaseRegistry(nextInput);

  if (next.releases.length < previous.releases.length) {
    throw new ReleaseRegistryError("Release registry entries cannot be removed.");
  }

  for (let index = 0; index < previous.releases.length; index += 1) {
    if (stableJson(previous.releases[index]) !== stableJson(next.releases[index])) {
      throw new ReleaseRegistryError(
        `Release registry entry ${previous.releases[index].version} is immutable and cannot change.`,
      );
    }
  }

  return next;
}

export function getReleaseByVersion(
  registry: ReleaseRegistry,
  version: string,
): ReleaseEntry | undefined {
  return registry.releases.find((entry) => entry.version === version);
}

function parseReleaseEntry(input: unknown, index: number): ReleaseEntry {
  if (!isRecord(input)) {
    throw new ReleaseRegistryError(`Release registry entry ${index} must be an object.`);
  }

  const version = requireString(input.version, `Release registry entry ${index} version`);
  if (!isProductRouteVersion(version)) {
    throw new ReleaseRegistryError(
      `Release registry entry ${index} has invalid version ${version}.`,
    );
  }

  const sourceCommit = requireCommit(
    input.sourceCommit,
    `Release registry entry ${version} sourceCommit`,
  );
  const player = parsePlayerArtifact(input.player, version);
  const worker = parseWorkerArtifact(input.worker, version);

  return { version, sourceCommit, player, worker };
}

function parsePlayerArtifact(input: unknown, version: string): PlayerReleaseArtifact {
  if (!isRecord(input)) {
    throw new ReleaseRegistryError(`Release ${version} player artifact must be an object.`);
  }
  const r2Prefix = requireString(input.r2Prefix, `Release ${version} player.r2Prefix`);
  if (r2Prefix !== `player/${version}/`) {
    throw new ReleaseRegistryError(
      `Release ${version} player.r2Prefix must equal player/${version}/.`,
    );
  }
  const sha256 = requireString(input.sha256, `Release ${version} player.sha256`);
  if (!/^sha256:[a-f0-9]{64}$/.test(sha256)) {
    throw new ReleaseRegistryError(`Release ${version} player.sha256 must be a lowercase SHA-256.`);
  }
  const builtAt = requireString(input.builtAt, `Release ${version} player.builtAt`);
  if (!Number.isFinite(Date.parse(builtAt))) {
    throw new ReleaseRegistryError(`Release ${version} player.builtAt must be an ISO date.`);
  }
  return { r2Prefix, sha256, builtAt };
}

function parseWorkerArtifact(input: unknown, version: string): WorkerReleaseArtifact {
  if (!isRecord(input)) {
    throw new ReleaseRegistryError(`Release ${version} worker artifact must be an object.`);
  }
  const serviceName = requireString(input.serviceName, `Release ${version} worker.serviceName`);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(serviceName)) {
    throw new ReleaseRegistryError(`Release ${version} worker.serviceName is invalid.`);
  }
  const bindingName = requireString(input.bindingName, `Release ${version} worker.bindingName`);
  if (!/^[A-Z][A-Z0-9_]{0,62}$/.test(bindingName)) {
    throw new ReleaseRegistryError(`Release ${version} worker.bindingName is invalid.`);
  }
  const expectedServiceName = `gn-tracing-oauth-proxy-v${version.replaceAll(".", "-")}`;
  if (serviceName !== expectedServiceName) {
    throw new ReleaseRegistryError(
      `Release ${version} worker.serviceName must equal ${expectedServiceName}.`,
    );
  }
  const expectedBindingName = `WORKER_${version.replaceAll(".", "_")}`;
  if (bindingName !== expectedBindingName) {
    throw new ReleaseRegistryError(
      `Release ${version} worker.bindingName must equal ${expectedBindingName}.`,
    );
  }
  const sourceCommit = requireCommit(input.sourceCommit, `Release ${version} worker.sourceCommit`);
  return { serviceName, bindingName, sourceCommit };
}

function parseUnknown(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new ReleaseRegistryError("Release registry JSON is invalid.");
  }
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new ReleaseRegistryError(`${label} must be a non-empty string.`);
  }
  return input.trim();
}

function requireCommit(input: unknown, label: string): string {
  const commit = requireString(input, label);
  if (!/^[a-f0-9]{7,64}$/.test(commit)) {
    throw new ReleaseRegistryError(`${label} must be a lowercase Git commit id.`);
  }
  return commit;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
