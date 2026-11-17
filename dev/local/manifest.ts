import * as fs from 'node:fs';
import * as path from 'node:path';

export type ManifestEntry = {
  name: string;
  port: number;
  group: string;
  type: string;
};

export type Manifest = {
  session: string;
  portOffset: number;
  wranglerRegistryPath: string;
  services: ManifestEntry[];
};

export function manifestPath(repoRoot: string): string {
  return path.join(repoRoot, 'dev', 'logs', 'manifest.json');
}

export function readManifest(repoRoot: string): Manifest | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(repoRoot), 'utf-8'));
    if (
      typeof raw?.session !== 'string' ||
      typeof raw?.portOffset !== 'number' ||
      !Array.isArray(raw?.services)
    ) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

export function findManifestPort(manifest: Manifest | undefined, name: string): number | undefined {
  const entry = manifest?.services.find(service => service?.name === name);
  return typeof entry?.port === 'number' && entry.port > 0 ? entry.port : undefined;
}

/**
 * The services a manifest recorded, in start order. A restart or a recreate
 * rebuilds a service's command from this selection, so the order the start used
 * is what it has to reproduce.
 */
export function manifestServiceNames(manifest: Manifest | undefined): string[] | undefined {
  return manifest?.services.map(service => service.name);
}

/**
 * The selection a restart rebuilds a service's command from: the services the
 * running stack recorded in its manifest. `dev:restart` takes it whole — a
 * relaunch or a recreate rebuilds the command from it, so it has to match the
 * one the start used, or the web app comes back without the Snowflake mock's
 * `NODE_EXTRA_CA_CERTS` export. Undefined when no manifest was written, which
 * keeps the plain service command.
 */
export function restartSelection(repoRoot: string): string[] | undefined {
  return manifestServiceNames(readManifest(repoRoot));
}
