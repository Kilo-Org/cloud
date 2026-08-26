import { File, Paths } from 'expo-file-system';
import { z } from 'zod';

const REGISTRY_FILENAME = 'temp-file-registry.json';

/** Age after which the default reap deletes a registered temp file. */
export const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000;

const tempFileEntrySchema = z.object({
  uri: z.string(),
  createdAt: z.number(),
});

const registrySchema = z.array(tempFileEntrySchema);

type TempFileEntry = z.infer<typeof tempFileEntrySchema>;

/** In-memory registry, lazily loaded from disk on first use. */
let entries: TempFileEntry[] | null = null;

function registryFile(): File {
  return new File(Paths.cache, REGISTRY_FILENAME);
}

function loadEntries(): TempFileEntry[] {
  if (entries !== null) {
    return entries;
  }
  try {
    const file = registryFile();
    if (file.exists) {
      const parsed = registrySchema.safeParse(JSON.parse(file.textSync()));
      entries = parsed.success ? parsed.data : [];
      return entries;
    }
  } catch {
    // A missing, corrupt, or unreadable registry starts empty. Never throws.
  }
  entries = [];
  return entries;
}

function persistEntries(): void {
  try {
    registryFile().write(JSON.stringify(entries ?? []));
  } catch {
    // Best-effort: the in-memory list stays authoritative for this session.
  }
}

function deleteRegisteredFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // A missing or undeletable file must never abort the reap.
  }
}

/**
 * Register an app-owned temp file for later reaping. Idempotent per URI, but
 * a second registration refreshes `createdAt`: downloads reuse a deterministic
 * cache filename, so re-sharing the same file rewrites that URI and the TTL
 * must run from the newest write. Keeping the first timestamp would let the
 * next reap delete a copy the receiving app is still reading.
 */
export function registerTempFile(uri: string): void {
  const current = loadEntries();
  const existing = current.find(entry => entry.uri === uri);
  if (existing) {
    existing.createdAt = Date.now();
  } else {
    current.push({ uri, createdAt: Date.now() });
  }
  persistEntries();
}

/**
 * Delete registered temp files. `all: true` deletes every registered file;
 * the default deletes only files older than `TEMP_FILE_TTL_MS`. Missing
 * files are skipped. Never throws.
 */
export function reapTempFiles({ all = false }: { all?: boolean } = {}): void {
  const current = loadEntries();
  const now = Date.now();
  const remaining: TempFileEntry[] = [];
  for (const entry of current) {
    const expired = all || now - entry.createdAt > TEMP_FILE_TTL_MS;
    if (expired) {
      deleteRegisteredFile(entry.uri);
    } else {
      remaining.push(entry);
    }
  }
  if (remaining.length === current.length) {
    // Nothing expired. Skipping the write keeps every cold start and every
    // foreground from rewriting the registry with identical content.
    return;
  }
  entries = remaining;
  persistEntries();
}

/** Test-only: wipe the in-memory registry between cases. */
export function __resetTempFileRegistryForTests(): void {
  entries = null;
}
