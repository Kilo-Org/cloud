/* eslint-disable max-lines -- one collector owns every query shape decoded from the cache and the source-ownership rule that authorises removals; splitting it would scatter one invariant across files. */
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
import { type Query, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { collectUnfilteredPages } from '@/lib/agent-session-pages';
import { getRecentPrs } from '@/lib/pr-review/recent-prs';
import {
  activeSessionSearchDocument,
  findingSearchDocument,
  inboxPrSearchDocument,
  PERSONAL_SOURCE_SCOPE,
  PR_RECENTS_SOURCE_KEY,
  providerPrSearchDocument,
  providerReviewSourceKey,
  recentPrSearchDocument,
  storedSessionSearchDocument,
  type SystemSearchDocument,
  systemSearchSourceKey,
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
  pages: z.array(z.object({ cliSessions: z.array(z.unknown()), nextCursor: z.string().nullish() })),
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
  pages: z.array(z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullish() })),
});

// The GitLab/Bitbucket inbox row carries its own ref, so the document can
// route through the row's provider instead of a fixed platform.
const providerPrRefSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('github'),
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  z.object({
    platform: z.literal('gitlab'),
    projectPath: z.string(),
    mrIid: z.number(),
    instanceHint: z.string().optional(),
  }),
  z.object({
    platform: z.literal('bitbucket'),
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
  }),
]);

const providerInboxItemRowSchema = z.object({
  ref: providerPrRefSchema,
  title: z.string().nullish(),
});

const findingRowSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  severity: z.string().nullish(),
  repo_full_name: z.string().nullish(),
});

const findingsDataSchema = z.object({
  pages: z.array(z.object({ findings: z.array(z.unknown()), totalCount: z.number().nullish() })),
});

const queryKeyMetaSchema = z.object({ input: z.unknown().optional() });
const organizationScopeInputSchema = z.object({ organizationId: z.string() });

/** A minimal decoder, so a row schema can be passed without its generics. */
type RowDecoder<TRow> = {
  safeParse: (value: unknown) => { success: true; data: TRow } | { success: false };
};

/**
 * Every document the app can build from its current cache, plus its stored PR
 * recents, deduped by id (first occurrence wins), together with the source
 * scopes whose queries this run could fully enumerate.
 *
 * The sources are what lets the sync distinguish "the source says the user can
 * no longer see this" from "the source's query is not in the cache this run"
 * (a cold start hydrates only a subset), so it never drops a still-valid entry
 * just because its query has not loaded yet. A scope is recorded only by a
 * query that enumerated it completely: an unfiltered list whose page window
 * `maxPages` has not trimmed and whose last page advertised its terminal
 * pagination marker.
 */
export type SystemSearchCollection = {
  documents: SystemSearchDocument[];
  observedSources: Set<string>;
};

export async function collectSystemSearchDocuments(
  queryClient: QueryClient
): Promise<SystemSearchCollection> {
  const documents: SystemSearchDocument[] = [];
  const observedSources = new Set<string>();
  for (const query of queryClient.getQueryCache().getAll()) {
    const collected = documentsFromQuery(query);
    documents.push(...collected.documents);
    // Only a successful query that fully enumerated a source scope is
    // authoritative. A query can hold the family path without enumerating it —
    // the findings capacity probe fetches `limit: 1` under `listFindings`, a
    // filtered list enumerates a subset, and a window trimmed by `maxPages`
    // enumerates only the newest pages — so its success is not evidence that
    // the rest of the source is gone, and it must not authorise removing that
    // source's index entries.
    if (query.state.status === 'success' && collected.observedSource !== null) {
      observedSources.add(collected.observedSource);
    }
  }
  const recents = await recentPrDocuments();
  documents.push(...recents.documents);
  if (recents.observedSource !== null) {
    observedSources.add(recents.observedSource);
  }
  return { documents: dedupeById(documents), observedSources };
}

/**
 * What one cached query carries: the documents it enumerates, and the source
 * scope key it fully enumerated, or null when it did not enumerate one. The
 * observed source is non-null only when `data` decoded as that source's list
 * payload, the key input carried no narrowing filter, the page window was not
 * trimmed, and the last page proved the list reached its end, so a probe, a
 * filtered list, a partial window or a first page with a next page never claims
 * a source.
 */
type QueryDocuments = {
  documents: SystemSearchDocument[];
  observedSource: string | null;
};

const NOT_ENUMERATED: QueryDocuments = { documents: [], observedSource: null };

/** The keys whose presence narrows a source list to a subset of its scope. */
const SESSION_NARROWING_KEYS = ['createdOnPlatform', 'gitUrl'] as const;
const FINDING_NARROWING_KEYS = [
  'status',
  'severity',
  'outcomeFilter',
  'repoFullName',
  'overdue',
] as const;

const sessionScopeInputSchema = z.object({ organizationId: z.string().min(1).nullish() });
const providerInboxInputSchema = z.object({
  platform: z.enum(['gitlab', 'bitbucket']),
  organizationId: z.string().optional(),
});
const PROVIDER_INBOX_KEYS = new Set(['platform', 'organizationId']);
const queryInputSchema = z.record(z.string(), z.unknown());
const maxPagesSchema = z.number();
const pagesDataSchema = z.object({ pages: z.array(z.unknown()) });

type QueryInput = z.infer<typeof queryInputSchema>;

function documentsFromQuery(query: Query): QueryDocuments {
  const queryKey = query.queryKey;
  const data = query.state.data;
  const path = queryKeyPath(queryKey);
  if (path === 'cliSessionsV2.list') {
    const parsed = storedSessionsDataSchema.safeParse(data);
    if (!parsed.success) {
      return NOT_ENUMERATED;
    }
    // The stored list is the cursor-paginated cliSessions shape the shared
    // page collector already flattens and dedupes by session id.
    const pages = parsed.data.pages.map(page => ({
      cliSessions: decodedRows(page.cliSessions, storedSessionRowSchema),
    }));
    return {
      documents: collectUnfilteredPages(pages).flatMap(row =>
        presentOrEmpty(storedSessionSearchDocument(row))
      ),
      observedSource: sessionObservedSource(query, reachedEndOfCursorPages(parsed.data.pages)),
    };
  }
  if (path === 'activeSessions.list') {
    const parsed = activeSessionsDataSchema.safeParse(data);
    if (!parsed.success) {
      return NOT_ENUMERATED;
    }
    // The live list enumerates only currently running sessions, a subset of
    // the stored history that already carries every session, so it contributes
    // documents but never authorises a removal.
    return {
      documents: decodedRows(parsed.data.sessions, activeSessionRowSchema).flatMap(row =>
        presentOrEmpty(activeSessionSearchDocument(row))
      ),
      observedSource: null,
    };
  }
  if (path === 'githubPrReview.listInbox') {
    const parsed = inboxDataSchema.safeParse(data);
    if (!parsed.success) {
      return NOT_ENUMERATED;
    }
    // The GitHub inbox is the whole GitHub provider list (`{}` is its only
    // input); the stored recents are unioned in below, so a GitHub id absent
    // from both is genuinely gone. A non-empty input is a filtered inbox.
    const input = queryInput(queryKey);
    const isDefaultInput = input !== null && Object.keys(input).length === 0;
    return {
      documents: parsed.data.pages
        .flatMap(page => decodedRows(page.items, inboxItemRowSchema))
        .map(row => inboxPrSearchDocument(row)),
      observedSource: isDefaultInput
        ? untrimmedSource(
            query,
            systemSearchSourceKey('pullRequests', 'github'),
            reachedEndOfCursorPages(parsed.data.pages)
          )
        : null,
    };
  }
  if (path === 'providerReview.listInbox') {
    // GitLab and Bitbucket fetch their inbox under the provider query (the
    // GitHub inbox keeps its own query), so without this branch those rows
    // were only ever indexed when they were also recents. Each row carries
    // its ref, so the document routes through the row's own provider.
    const parsed = inboxDataSchema.safeParse(data);
    if (!parsed.success) {
      return NOT_ENUMERATED;
    }
    const rows = parsed.data.pages.flatMap(page =>
      decodedRows(page.items, providerInboxItemRowSchema)
    );
    // The provider route cannot carry an organization, so identity has to: the
    // source key is organization-qualified, and every document this query
    // enumerates records that scope in its fingerprint. An organization's
    // inbox therefore never authorises a removal for another organization's.
    const scope = providerInboxScope(queryInput(queryKey));
    if (scope === null) {
      return {
        documents: rows.map(row => providerPrSearchDocument(row.ref, row.title ?? '')),
        observedSource: null,
      };
    }
    const sourceKey = providerReviewSourceKey(scope.provider, scope.organizationId);
    return {
      documents: rows.map(row =>
        providerPrSearchDocument(
          row.ref,
          row.title ?? '',
          providerReviewSourceKey(row.ref.platform, scope.organizationId)
        )
      ),
      observedSource: scope.isDefault
        ? untrimmedSource(query, sourceKey, reachedEndOfCursorPages(parsed.data.pages))
        : null,
    };
  }
  if (path === 'securityAgent.listFindings') {
    return findingsFromQuery(query, PERSONAL_SECURITY_SCOPE);
  }
  if (path === 'organizations.securityAgent.listFindings') {
    const organization = organizationScope(queryKey);
    return organization === null ? NOT_ENUMERATED : findingsFromQuery(query, organization);
  }
  return NOT_ENUMERATED;
}

function findingsFromQuery(query: Query, scope: string): QueryDocuments {
  const parsed = findingsDataSchema.safeParse(query.state.data);
  if (!parsed.success) {
    return NOT_ENUMERATED;
  }
  // The findings list is filtered by status/severity/outcome by default, so a
  // query with any of those keys enumerates only a subset and must not speak
  // for the whole scope. Only the unfiltered list (the "all" status) does.
  const filtered = hasNarrowingFilter(findingsFilters(query.queryKey), FINDING_NARROWING_KEYS);
  const rows = parsed.data.pages.flatMap(page => decodedRows(page.findings, findingRowSchema));
  return {
    documents: rows.map(row => findingSearchDocument(row, scope)),
    observedSource: filtered
      ? null
      : untrimmedSource(
          query,
          systemSearchSourceKey('findings', scope),
          reachedEndOfFindings(parsed.data.pages, rows.length)
        ),
  };
}

/**
 * The filters segment of a findings list key. The screen builds the list as
 * `[...queryKey(), filters]`, so the filters ride in tRPC's third segment while
 * the meta (carrying the organization input, if any) stays at index 1. A
 * length-two key (the capacity probe's `queryOptions` shape) keeps its input in
 * the meta instead.
 */
function findingsFilters(queryKey: readonly unknown[]): QueryInput | null {
  const filters = queryInputSchema.safeParse(queryKey[2]);
  return filters.success ? filters.data : queryInput(queryKey);
}

/**
 * The source key a stored-sessions query fully enumerated, or null when its
 * input narrows the list (a platform or repository filter) so it only carries
 * a subset of its scope.
 */
function sessionObservedSource(query: Query, reachedEnd: boolean): string | null {
  const input = queryInput(query.queryKey);
  if (hasNarrowingFilter(input, SESSION_NARROWING_KEYS)) {
    return null;
  }
  const scope = sessionScopeInputSchema.safeParse(input);
  const organizationId = scope.success ? scope.data.organizationId : undefined;
  return untrimmedSource(
    query,
    systemSearchSourceKey('sessions', organizationId ?? PERSONAL_SOURCE_SCOPE),
    reachedEnd
  );
}

/**
 * The candidate source key, or null when the query cannot prove it reached the
 * end of the source. A source is authoritative only when the last decoded page
 * advertised its terminal pagination marker (`nextCursor: null`, or a findings
 * page whose total count is covered) and `maxPages` has not evicted pages: a
 * first page that still has a next page is a partial window, and treating it as
 * complete would let a refresh delete results indexed from later pages.
 */
function untrimmedSource(query: Query, source: string, reachedEnd: boolean): string | null {
  if (!reachedEnd) {
    return null;
  }
  const bound = maxPagesSchema.safeParse(query.options.maxPages);
  if (!bound.success) {
    return source;
  }
  const pages = pagesDataSchema.safeParse(query.state.data);
  // A full window may already have evicted its oldest pages, so its rows are a
  // subset of the source; only a window still shorter than the bound is a
  // complete enumeration of what the query has loaded.
  return pages.success && pages.data.pages.length >= bound.data ? null : source;
}

/**
 * Whether the last page of a cursor-paginated list advertised its terminal
 * marker. `null` is the server's "no next page"; an absent field is a legacy or
 * malformed payload and is treated as "more may follow".
 */
function reachedEndOfCursorPages(
  pages: readonly { nextCursor?: string | null | undefined }[]
): boolean {
  return pages.at(-1)?.nextCursor === null;
}

/**
 * Whether the findings list reached the end of its scope. The findings page
 * carries `totalCount` instead of a cursor, so the decoded rows (which start at
 * the query's initial offset) cover every finding when their count reaches it.
 */
function reachedEndOfFindings(
  pages: readonly { totalCount?: number | null | undefined }[],
  loaded: number
): boolean {
  const total = pages.at(-1)?.totalCount;
  return total !== null && total !== undefined && loaded >= total;
}

/** Whether the query's input carries any of the narrowing filter keys. */
function hasNarrowingFilter(input: QueryInput | null, keys: readonly string[]): boolean {
  // An input this module does not recognise is not evidence of a full read.
  if (input === null) {
    return true;
  }
  return keys.some(key => {
    const value = input[key];
    return value !== undefined && value !== null && value !== '';
  });
}

/**
 * The provider and organization a provider inbox query enumerates, or null
 * when the input does not name one this module issued. `isDefault` is false
 * when the input carries an extra key, so a narrowed list contributes documents
 * but never claims the source scope.
 */
function providerInboxScope(
  input: QueryInput | null
): { provider: string; organizationId: string | null; isDefault: boolean } | null {
  const parsed = providerInboxInputSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  const organizationId = parsed.data.organizationId;
  return {
    provider: parsed.data.platform,
    organizationId:
      organizationId !== undefined && organizationId.length > 0 ? organizationId : null,
    isDefault: input !== null && Object.keys(input).every(key => PROVIDER_INBOX_KEYS.has(key)),
  };
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

/** The `organizationId` of an organization-scoped query key, or null. */
function organizationScope(queryKey: readonly unknown[]): string | null {
  const meta = queryKeyMetaSchema.safeParse(queryKey[1]);
  if (!meta.success) {
    return null;
  }
  const input = organizationScopeInputSchema.safeParse(meta.data.input);
  return input.success ? input.data.organizationId : null;
}

/** The query key's input payload as a plain object, or null when it has none. */
function queryInput(queryKey: readonly unknown[]): QueryInput | null {
  const meta = queryKeyMetaSchema.safeParse(queryKey[1]);
  const parsed = queryInputSchema.safeParse(meta.success ? meta.data.input : undefined);
  return parsed.success ? parsed.data : null;
}

function queryKeyPath(queryKey: readonly unknown[]): string | null {
  const segments = queryKeyPathSchema.safeParse(queryKey[0]);
  return segments.success ? segments.data.join('.') : null;
}

/**
 * The stored PR recents and the source scope they enumerate. The recents list
 * is bounded (ten entries) but it is the whole list, so a successful read
 * authorises removing a recents-sourced entry that has fallen off it — while a
 * failed read observes nothing and leaves the index alone.
 */
async function recentPrDocuments(): Promise<{
  documents: SystemSearchDocument[];
  observedSource: string | null;
}> {
  try {
    const recents = await getRecentPrs();
    return {
      documents: recents.map(entry => recentPrSearchDocument(entry)),
      observedSource: PR_RECENTS_SOURCE_KEY,
    };
  } catch {
    // SecureStore can fail (locked device, corrupt entry); the index then
    // simply carries no recents rather than failing the whole collection.
    return { documents: [], observedSource: null };
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
