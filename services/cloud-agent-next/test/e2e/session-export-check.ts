/**
 * Test-only oracle for the session-export/restore contract.
 *
 * The production contract this mirrors is owned by
 * `wrapper/src/restore-session.ts` (`JQ_EXTRACT_DIFFS_FILTER` and
 * `extractDiffsWithBun`: a non-empty `sessionDiff` suppresses message-summary
 * diffs, then last-write-wins by `file`) and by the
 * `GET /api/session/:sessionId/export` route in `services/session-ingest`.
 * Keep the precedence rule here in sync with those owners.
 *
 * `bestEffortExportDiagnostic` is a bounded, non-gating diagnostic: it reports
 * `true` / `false` / `'unknown'` and never throws into the scenario.
 */

import { mintApiToken } from './auth.js';
import type { DriverConfig } from './client.js';

export type ExportDiagnosticResources = {
  config: DriverConfig;
  within: <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
};

/** A single `SnapshotDiff` entry as produced by the session export. */
export type ExportDiff = {
  file?: unknown;
  patch?: unknown;
  after?: unknown;
  [key: string]: unknown;
};

export type SentinelDiffInput = {
  sentinelPath: string;
  sentinelContents: string;
};

export type SentinelDiffStatus = 'usable' | 'missing' | 'mismatch' | 'unknown';

export type ExportTurnInput = {
  messageId: string;
  assistantMarker: string;
};

export type ExportDiagnosticInput = SentinelDiffInput & ExportTurnInput & { kiloSessionId: string };

/** Fetch timeout that keeps the diagnostic bounded independently of the scenario budget. */
const EXPORT_DIAGNOSTIC_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract diffs from a parsed session export with the restore precedence:
 * a non-empty top-level `sessionDiff` wins outright; otherwise collect
 * message-summary diffs. Last write for a given `file` wins.
 */
export function collectExportDiffs(data: unknown): ExportDiff[] {
  if (!isRecord(data)) return [];
  const dedup = new Map<string, ExportDiff>();

  const sessionDiff = data.sessionDiff;
  if (Array.isArray(sessionDiff) && sessionDiff.length > 0) {
    for (const diff of sessionDiff) {
      if (isRecord(diff) && typeof diff.file === 'string') dedup.set(diff.file, diff);
    }
    return Array.from(dedup.values());
  }

  const messages = data.messages;
  if (!Array.isArray(messages)) return [];
  for (const message of messages) {
    const info = isRecord(message) ? message.info : undefined;
    const summary = isRecord(info) ? info.summary : undefined;
    if (!isRecord(summary) || !Array.isArray(summary.diffs)) continue;
    for (const diff of summary.diffs) {
      if (isRecord(diff) && typeof diff.file === 'string') dedup.set(diff.file, diff);
    }
  }
  return Array.from(dedup.values());
}

/**
 * Classify the sentinel file's diff. A non-empty `patch` is not proof that the
 * exact bytes are reconstructible, so it yields `'unknown'` even when `after`
 * is also present and matches; `after` is consulted only when there is no
 * non-empty patch. (Reconstructibility of a patch is never validated here.)
 */
export function inspectSentinelDiff(data: unknown, input: SentinelDiffInput): SentinelDiffStatus {
  const diff = collectExportDiffs(data).find(entry => entry.file === input.sentinelPath);
  if (!diff) return 'missing';
  const patch = typeof diff.patch === 'string' ? diff.patch : undefined;
  if (patch !== undefined && patch.length > 0) return 'unknown';
  if (typeof diff.after === 'string' && diff.after === input.sentinelContents) return 'usable';
  return 'mismatch';
}

export function hasUsableSentinelDiff(data: unknown, input: SentinelDiffInput): boolean {
  return inspectSentinelDiff(data, input) === 'usable';
}

/** Concatenate text parts of an exported message (SDK `parts` shape). */
function messageText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.parts)) return '';
  let text = '';
  for (const part of message.parts) {
    if (isRecord(part) && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * True when the export contains both the completed user turn (`messageId`) and
 * its terminal assistant reply carrying `assistantMarker`.
 */
export function exportContainsTurn(data: unknown, input: ExportTurnInput): boolean {
  if (!isRecord(data) || !Array.isArray(data.messages)) return false;
  let userFound = false;
  let assistantFound = false;
  for (const message of data.messages) {
    if (!isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : undefined;
    if (!info) continue;
    if (info.role === 'user' && info.id === input.messageId) userFound = true;
    const completedAt = isRecord(info.time) ? info.time.completed : undefined;
    if (
      info.role === 'assistant' &&
      info.parentID === input.messageId &&
      typeof completedAt === 'number' &&
      messageText(message).includes(input.assistantMarker)
    ) {
      assistantFound = true;
    }
  }
  return userFound && assistantFound;
}

/**
 * Derive the session-ingest base URL from the environment. Returns undefined
 * when it is not configured. `.dev.vars` points the sandbox at
 * `host.docker.internal`; the host-side driver reaches the same port on
 * `localhost`.
 */
function resolveSessionIngestBaseUrl(): string | undefined {
  const raw = process.env.KILO_SESSION_INGEST_URL ?? process.env.SESSION_INGEST_WORKER_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.hostname === 'host.docker.internal') url.hostname = 'localhost';
    return url.origin;
  } catch {
    return undefined;
  }
}

async function fetchSessionExport(
  resources: ExportDiagnosticResources,
  kiloSessionId: string,
  signal: AbortSignal
): Promise<unknown | null> {
  const baseUrl = resolveSessionIngestBaseUrl();
  if (!baseUrl) return null;
  const url = `${baseUrl}/api/session/${encodeURIComponent(kiloSessionId)}/export`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${mintApiToken(resources.config.user, resources.config.nextAuthSecret)}`,
    },
    signal,
  });
  if (!response.ok) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Best-effort observation of whether the session export holds the pre-cold
 * turn and a reconstructible sentinel diff. Never gates: a missing base URL,
 * fetch failure, timeout, or unparseable body all report `'unknown'`.
 */
export async function bestEffortExportDiagnostic(
  resources: ExportDiagnosticResources,
  input: ExportDiagnosticInput
): Promise<boolean | 'unknown'> {
  try {
    return await resources.within('session-export diagnostic', async signal => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(EXPORT_DIAGNOSTIC_TIMEOUT_MS)]);
      const data = await fetchSessionExport(resources, input.kiloSessionId, bounded);
      if (data === null) return 'unknown' as const;
      if (!exportContainsTurn(data, input)) return false;
      const sentinelStatus = inspectSentinelDiff(data, input);
      if (sentinelStatus === 'usable') return true;
      if (sentinelStatus === 'unknown') return 'unknown' as const;
      return false;
    });
  } catch {
    return 'unknown';
  }
}
