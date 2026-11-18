import * as fs from 'node:fs';
import * as path from 'node:path';

import { getAlwaysOnGroupIds, resolveGroups } from './services';

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
 * The services a stack start always runs, in start order: the always-on groups
 * with their transitive dependencies. A restart has to fall back to this when
 * the manifest is missing — a start interrupted before `writeManifest` leaves
 * no record, and the running session's panes were still built from this
 * selection (`dev:start` merges every extra target into it).
 */
export function alwaysOnSelection(): string[] {
  return resolveGroups(getAlwaysOnGroupIds());
}

/**
 * The selection a restart rebuilds a service's command from: the services the
 * running stack recorded in its manifest. `dev:restart` takes it whole — a
 * relaunch or a recreate rebuilds the command from it, so it has to match the
 * one the start used, or the web app comes back without the Snowflake mock's
 * `NODE_EXTRA_CA_CERTS` export.
 *
 * A running session with no manifest on disk (a start interrupted before the
 * write, or `clearDevLogs` during teardown) still gets a selection: the
 * always-on core group is what every start runs, and `cmdRestart` reaches this
 * only for a live session. A manifest with no services is just as unrecorded.
 * A selection the manifest would narrow — a start with
 * `--without=mock-snowflake` — keeps its record, because a manifest exists
 * whenever a start finished.
 */
export function restartSelection(repoRoot: string): string[] {
  const names = manifestServiceNames(readManifest(repoRoot));
  return names === undefined || names.length === 0 ? alwaysOnSelection() : names;
}
