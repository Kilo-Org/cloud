/**
 * Collect the index documents from what the app already holds.
 *
 * The collector reads only the react-query cache (`getQueryCache().getAll()`)
 * plus the locally stored PR recents, so building the index never starts a
 * background fetch: no `fetchQuery`, `prefetchQuery`, `refetch` or tRPC
 * client is reachable from this module. Every cached value is decoded row by
 * row and a malformed row is skipped, never thrown on — one bad row must not
 * cost the rest of its page.
 */

import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { collectUnfilteredPages } from '@/lib/agent-session-pages';
import { getRecentPrs } from '@/lib/pr-review/recent-prs';
import {
  activeSessionSearchDocument,
  findingSearchDocument,
  inboxPrSearchDocument,
  recentPrSearchDocument,
  storedSessionSearchDocument,
  type SystemSearchDocument,
} from '@/lib/system-search-entries';

// ── cache decoding ─────────────────────────────────────────────────────────
// The cache holds `unknown` payloads, so each known query shape is decoded at
// this boundary. A page keeps its rows `unknown` so one malformed row is
// dropped alone; a payload that does not match at all yields no documents.

const queryKeyPathSchema = z.array(z.string()).min(1);

const storedSessionRowSchema = z.object({
  session_id: z.string(),
  title: z.string().nullish(),
  organization_id: z.string().nullish(),
  git_branch: z.string().nullish(),
});

const storedSessionsDataSchema = z.object({
  pages: z.array(z.object({ cliSessions: z.array(z.unknown()) })),
});

const activeSessionRowSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  organizationId: z.string().nullish(),
  gitBranch: z.string().nullish(),
});

const activeSessionsDataSchema = z.object({ sessions: z.array(z.unknown()) });

const inboxItemRowSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string().nullish(),
});

const inboxDataSchema = z.object({
  pages: z.array(z.object({ items: z.array(z.unknown()) })),
});

const findingRowSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  severity: z.string().nullish(),
  repo_full_name: z.string().nullish(),
});

const findingsDataSchema = z.object({
  pages: z.array(z.object({ findings: z.array(z.unknown()) })),
});

const queryKeyMetaSchema = z.object({ input: z.unknown().optional() });
const organizationScopeInputSchema = z.object({ organizationId: z.string() });

/** A minimal decoder, so a row schema can be passed without its generics. */
type RowDecoder<TRow> = {
  safeParse: (value: unknown) => { success: true; data: TRow } | { success: false };
};

/**
 * Every document the app can build from its current cache, plus its stored PR
 * recents, deduped by id (first occurrence wins).
 */
export async function collectSystemSearchDocuments(
  queryClient: QueryClient
): Promise<SystemSearchDocument[]> {
  const documents: SystemSearchDocument[] = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    documents.push(...documentsFromQuery(query.queryKey, query.state.data));
  }
  documents.push(...(await recentPrDocuments()));
  return dedupeById(documents);
}

function documentsFromQuery(queryKey: readonly unknown[], data: unknown): SystemSearchDocument[] {
  const path = queryKeyPath(queryKey);
  if (path === 'cliSessionsV2.list') {
    const parsed = storedSessionsDataSchema.safeParse(data);
    if (!parsed.success) {
      return [];
    }
    // The stored list is the cursor-paginated cliSessions shape the shared
    // page collector already flattens and dedupes by session id.
    const pages = parsed.data.pages.map(page => ({
      cliSessions: decodedRows(page.cliSessions, storedSessionRowSchema),
    }));
    return collectUnfilteredPages(pages).flatMap(row =>
      presentOrEmpty(storedSessionSearchDocument(row))
    );
  }
  if (path === 'activeSessions.list') {
    const parsed = activeSessionsDataSchema.safeParse(data);
    if (!parsed.success) {
      return [];
    }
    return decodedRows(parsed.data.sessions, activeSessionRowSchema).flatMap(row =>
      presentOrEmpty(activeSessionSearchDocument(row))
    );
  }
  if (path === 'githubPrReview.listInbox') {
    const parsed = inboxDataSchema.safeParse(data);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.pages
      .flatMap(page => decodedRows(page.items, inboxItemRowSchema))
      .map(row => inboxPrSearchDocument(row));
  }
  if (path === 'securityAgent.listFindings') {
    return findingDocuments(data, PERSONAL_SECURITY_SCOPE);
  }
  if (path === 'organizations.securityAgent.listFindings') {
    const organization = organizationScope(queryKey);
    return organization === null ? [] : findingDocuments(data, organization);
  }
  return [];
}

/** Decode one page of rows, dropping a malformed row alone. */
function decodedRows<TRow>(rows: readonly unknown[], rowSchema: RowDecoder<TRow>): TRow[] {
  const decoded: TRow[] = [];
  for (const row of rows) {
    const result = rowSchema.safeParse(row);
    if (result.success) {
      decoded.push(result.data);
    }
  }
  return decoded;
}

function findingDocuments(data: unknown, scope: string): SystemSearchDocument[] {
  const parsed = findingsDataSchema.safeParse(data);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.pages
    .flatMap(page => decodedRows(page.findings, findingRowSchema))
    .map(row => findingSearchDocument(row, scope));
}

/** The `organizationId` of an organization-scoped query key, or null. */
function organizationScope(queryKey: readonly unknown[]): string | null {
  const meta = queryKeyMetaSchema.safeParse(queryKey[1]);
  if (!meta.success) {
    return null;
  }
  const input = organizationScopeInputSchema.safeParse(meta.data.input);
  return input.success ? input.data.organizationId : null;
}

function queryKeyPath(queryKey: readonly unknown[]): string | null {
  const segments = queryKeyPathSchema.safeParse(queryKey[0]);
  return segments.success ? segments.data.join('.') : null;
}

async function recentPrDocuments(): Promise<SystemSearchDocument[]> {
  try {
    const recents = await getRecentPrs();
    return recents.map(entry => recentPrSearchDocument(entry));
  } catch {
    // SecureStore can fail (locked device, corrupt entry); the index then
    // simply carries no recents rather than failing the whole collection.
    return [];
  }
}

function presentOrEmpty(document: SystemSearchDocument | null): SystemSearchDocument[] {
  return document === null ? [] : [document];
}

function dedupeById(documents: readonly SystemSearchDocument[]): SystemSearchDocument[] {
  const seen = new Set<string>();
  const result: SystemSearchDocument[] = [];
  for (const document of documents) {
    if (!seen.has(document.id)) {
      seen.add(document.id);
      result.push(document);
    }
  }
  return result;
}
