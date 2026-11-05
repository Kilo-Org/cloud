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
