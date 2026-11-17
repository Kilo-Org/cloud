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
 * The selection a running stack was started with, in start order. A restart or
 * a recreate rebuilds a service's command from it, so it has to match the one
 * the start used: `serviceCommand` adds the Snowflake mock's CA bundle to the
 * web app only when the mock is in the selection. Undefined when the session
 * recorded no manifest, which keeps the plain service command.
 */
export function manifestServiceNames(manifest: Manifest | undefined): string[] | undefined {
  return manifest?.services.map(service => service.name);
}
