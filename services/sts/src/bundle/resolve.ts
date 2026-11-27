import { z } from 'zod';
import type { ManagerEntry } from '../infisical/client';
import type { BundleSecrets } from '../types';

export type RefusedReference = { path: string; name: string; version: number };

/** What the refresher keeps of one folder: the entries it will serve and the refused references. */
export type FolderCopy = { entries: ManagerEntry[]; refused: RefusedReference[] };

export const FolderCopySchema: z.ZodType<FolderCopy> = z.strictObject({
  entries: z.array(
    z.strictObject({
      path: z.string(),
      name: z.string(),
      id: z.string(),
      version: z.number().int().nonnegative(),
      value: z.string(),
    })
  ),
  refused: z.array(
    z.strictObject({ path: z.string(), name: z.string(), version: z.number().int().nonnegative() })
  ),
});

/** The kilo project uses no secret references, so a value in reference syntax is refused (design 4.2). */
const REFERENCE_PREFIX = '${';

function entryKey(entry: { path: string; name: string }): string {
  return `${entry.path}\n${entry.name}`;
}

/**
 * Applies the reference rule to a fresh folder read. A refused value keeps the last good copy of
 * that one secret, or drops the secret when there is none. `newlyRefused` lists refusals the
 * previous copy did not already report, so each one alerts once.
 */
export function acceptFolderRead(
  fresh: ManagerEntry[],
  previous: FolderCopy | null
): { copy: FolderCopy; newlyRefused: Array<RefusedReference & { keptLastGood: boolean }> } {
  const previousEntries = new Map(previous?.entries.map(entry => [entryKey(entry), entry]));
  const previousRefused = new Set(
    previous?.refused.map(entry => `${entryKey(entry)}\n${entry.version}`)
  );
  const entries: ManagerEntry[] = [];
  const refused: RefusedReference[] = [];
  const newlyRefused: Array<RefusedReference & { keptLastGood: boolean }> = [];
  for (const entry of fresh) {
    if (!entry.value.startsWith(REFERENCE_PREFIX)) {
      entries.push(entry);
      continue;
    }
    const reference = { path: entry.path, name: entry.name, version: entry.version };
    refused.push(reference);
    const lastGood = previousEntries.get(entryKey(entry));
    if (lastGood !== undefined) entries.push(lastGood);
    if (!previousRefused.has(`${entryKey(entry)}\n${entry.version}`)) {
      newlyRefused.push({ ...reference, keptLastGood: lastGood !== undefined });
    }
  }
  return { copy: { entries, refused }, newlyRefused };
}

/**
 * Resolves each name a workload's policy grants: its own folder first (`/workloads/<workload>`, or
 * `/ci/<workload>` for a GitHub policy), then `/shared` (design 4.2). Secrets in deeper folders are
 * never served. `own` is the copy of the root folder that holds `ownPath`.
 */
export function resolveWorkloadSecrets(
  ownPath: string,
  names: readonly string[],
  own: FolderCopy,
  shared: FolderCopy
): { secrets: BundleSecrets; missing: string[] } {
  const ownEntries = new Map<string, ManagerEntry>();
  for (const entry of own.entries) {
    if (entry.path === ownPath) ownEntries.set(entry.name, entry);
  }
  const common = new Map<string, ManagerEntry>();
  for (const entry of shared.entries) {
    if (entry.path === '/shared') common.set(entry.name, entry);
  }
  const secrets: BundleSecrets = {};
  const missing: string[] = [];
  for (const name of names) {
    const entry = ownEntries.get(name) ?? common.get(name);
    if (entry === undefined) missing.push(name);
    else secrets[name] = { value: entry.value, version: entry.version, id: entry.id };
  }
  return { secrets, missing };
}
