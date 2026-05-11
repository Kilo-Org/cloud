import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RestoreResult =
  | {
      ok: true;
      downloaded: boolean;
      imported: true;
      diffs: { applied: number; skipped: number; total: number };
    }
  | { ok: false; error: string; code: number | null; step: 'download' | 'import' | 'diffs' };

type SnapshotDiff = {
  file: string;
  after: string;
  status: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.error(`restore-session: ${msg}`);
}

function fail(
  error: string,
  code: number | null,
  step: Extract<RestoreResult, { ok: false }>['step']
): RestoreResult {
  return { ok: false, error, code, step };
}

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    log('cleaned up temp file');
  } catch {
    // temp file may not exist yet
  }
}

// jq filter that extracts diffs from the snapshot JSON using last-write-wins
// deduplication by file path. Runs as a subprocess so the full parsed snapshot
// is never loaded into the main process's heap — jq's C-native parser uses
// ~half the memory of a V8 heap.
// `objects` filters out non-object .summary values (e.g. compaction messages set summary=true)
const JQ_EXTRACT_DIFFS_FILTER =
  'reduce (.messages[]?.info.summary | objects | .diffs[]? // empty) as $d ({}; .[$d.file] = $d) | [.[]]';

/**
 * Extract last-write-wins diffs from a snapshot file. Prefers a jq subprocess
 * (memory-efficient — the parsed snapshot stays in C-native heap) and falls
 * back to bun-native parsing when jq isn't on PATH. The fallback matters for
 * the devcontainer flow: the user's image is only required to ship `node` +
 * `bun`, so `jq` may be missing.
 */
export async function extractDiffs(snapshotPath: string): Promise<SnapshotDiff[] | null> {
  try {
    const proc = Bun.spawn(['jq', '-c', JQ_EXTRACT_DIFFS_FILTER, snapshotPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const stdout = await new Response(proc.stdout).text();
      try {
        return JSON.parse(stdout) as SnapshotDiff[];
      } catch (err) {
        log(`jq output parse failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
    const stderr = await new Response(proc.stderr).text();
    log(`jq failed exitCode=${exitCode} stderr=${stderr.trim()}; falling back to bun parser`);
  } catch (err) {
    // `Bun.spawn` rejects with ENOENT when jq isn't installed.
    log(`jq not available (${err instanceof Error ? err.message : String(err)}); using bun parser`);
  }

  return extractDiffsWithBun(snapshotPath);
}

/**
 * In-process fallback for environments without `jq`. Loads the whole snapshot
 * into the V8 heap and applies the same last-write-wins dedup the jq filter
 * does. Higher peak memory than jq but avoids a hard dependency.
 */
async function extractDiffsWithBun(snapshotPath: string): Promise<SnapshotDiff[] | null> {
  type SnapshotShape = {
    messages?: Array<{
      info?: {
        summary?: { diffs?: SnapshotDiff[] };
      };
    }>;
  };
  let parsed: SnapshotShape;
  try {
    parsed = (await Bun.file(snapshotPath).json()) as SnapshotShape;
  } catch (err) {
    log(`bun snapshot parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const dedup = new Map<string, SnapshotDiff>();
  for (const message of parsed.messages ?? []) {
    const summary = message?.info?.summary;
    if (!summary || typeof summary !== 'object') continue;
    for (const diff of summary.diffs ?? []) {
      if (diff && typeof diff.file === 'string') dedup.set(diff.file, diff);
    }
  }
  return Array.from(dedup.values());
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

export async function restoreSession(
  kiloSessionId: string,
  workspacePath: string,
  filePath?: string
): Promise<RestoreResult> {
  const tmpPath = filePath ?? `/tmp/kilo-session-export-${kiloSessionId}.json`;
  const downloaded = !filePath;

  log(`starting kiloSessionId=${kiloSessionId} workspace=${workspacePath}`);

  if (!filePath) {
    const ingestUrl = process.env.KILO_SESSION_INGEST_URL;
    const token = process.env.KILOCODE_TOKEN;

    if (!ingestUrl || !token) {
      const missing = [!ingestUrl && 'KILO_SESSION_INGEST_URL', !token && 'KILOCODE_TOKEN']
        .filter(Boolean)
        .join(', ');
      return fail(`missing env vars: ${missing}`, null, 'download');
    }

    log(`ingestUrl=${ingestUrl}`);

    // ---- Step 1: Download snapshot (stream directly to disk) ----
    log('downloading snapshot');
    try {
      const url = `${ingestUrl}/api/session/${encodeURIComponent(kiloSessionId)}/export`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(300_000),
      });

      if (!res.ok) {
        if (res.status === 404) {
          log('snapshot not found (404)');
          return fail('snapshot not found (404)', 404, 'download');
        }
        log(`download failed status=${res.status}`);
        return fail(`download failed status=${res.status}`, 502, 'download');
      }

      const bytesWritten = await Bun.write(tmpPath, res);
      log(`snapshot downloaded bytes=${bytesWritten}`);

      // Validate before handing off to `kilo import`: an upstream error
      // surface (e.g. a JSON `{"detail":"..."}` body served as 200) crashes
      // kilo with a cryptic `undefined is not an object (evaluating 'info2.id')`
      // and exit 1. Catch the obvious malformed cases here so the failure
      // points at session-ingest instead.
      let snapshotInfo: { info?: { id?: unknown } };
      try {
        snapshotInfo = (await Bun.file(tmpPath).json()) as { info?: { id?: unknown } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`snapshot is not valid JSON: ${message}`);
        return fail(`snapshot is not valid JSON (${bytesWritten} bytes)`, null, 'download');
      }
      if (typeof snapshotInfo.info?.id !== 'string') {
        log('snapshot missing info.id — likely an error response');
        return fail(
          `snapshot missing info.id (${bytesWritten} bytes); session-ingest may have returned an error body`,
          null,
          'download'
        );
      }
    } catch (err) {
      tryUnlink(tmpPath);
      const message = err instanceof Error ? err.message : String(err);
      return fail(message, null, 'download');
    }
  } else {
    log(`using provided file=${filePath}`);
  }

  try {
    // ---- Step 2: Run kilo import ----
    log('running kilo import');
    const importProc = Bun.spawn(['kilo', 'import', tmpPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: workspacePath,
      env: process.env,
    });
    const exitCode = await importProc.exited;

    if (exitCode !== 0) {
      log(`kilo import failed exitCode=${exitCode}`);
      return fail(`kilo import failed exitCode=${exitCode}`, null, 'import');
    }
    log('kilo import succeeded');

    // ---- Step 3: Apply diffs ----
    // Extract diffs in a subprocess so the full snapshot JSON is never loaded
    // into this process's heap — only the small diff array crosses the boundary.
    const uniqueDiffs = await extractDiffs(tmpPath);
    if (uniqueDiffs === null) {
      return fail('failed to parse snapshot JSON', null, 'diffs');
    }
    const total = uniqueDiffs.length;

    if (total === 0) {
      log('no diffs to apply');
      return {
        ok: true,
        downloaded,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      };
    }

    log(`found ${total} unique file diffs`);

    const resolvedWorkspace = path.resolve(workspacePath);
    let applied = 0;
    let skipped = 0;

    for (const diff of uniqueDiffs) {
      const fp = path.resolve(resolvedWorkspace, diff.file);

      if (!fp.startsWith(resolvedWorkspace + '/')) {
        log(`skipping diff outside workspace file=${fp}`);
        skipped++;
        continue;
      }

      try {
        if (diff.status === 'deleted') {
          try {
            fs.unlinkSync(fp);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          applied++;
        } else if (diff.after) {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, diff.after);
          applied++;
        } else {
          skipped++;
        }
      } catch {
        log(`failed to apply diff file=${fp}`);
        skipped++;
      }
    }

    log(`diffs applied=${applied} skipped=${skipped} total=${total}`);
    log('completed successfully');

    return { ok: true, downloaded, imported: true, diffs: { applied, skipped, total } };
  } finally {
    tryUnlink(tmpPath);
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint — only runs when executed directly, not when imported
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  let filePath: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--file') {
      filePath = rawArgs[++i];
    } else {
      positional.push(rawArgs[i]);
    }
  }

  const [kiloSessionId, workspacePath] = positional;
  if (!kiloSessionId || !workspacePath) {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'Usage: kilo-restore-session [--file <path>] <kiloSessionId> <workspacePath>',
        code: null,
        step: 'download',
      })
    );
    process.exit(1);
  }
  void restoreSession(kiloSessionId, workspacePath, filePath).then(result => {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  });
}
