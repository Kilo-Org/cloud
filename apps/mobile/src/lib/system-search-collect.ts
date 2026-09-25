/* eslint-disable max-lines -- the collector decodes every source shape and the completeness checks live beside the decoders they guard */
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
import { getRecentPrsForIndex } from '@/lib/pr-review/recent-prs';
import { dedupeBy } from '@/lib/query/dedupe-by-id';
import {
  activeSessionSearchDocument,
  findingSearchDocument,
  inboxPrSearchDocument,
  PERSONAL_SOURCE_SCOPE,
  providerInboxSourceScope,
  providerPrSearchDocument,
  recentPrSearchDocument,
  recentPrSourceScopes,
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
 * recents, deduped by id (first occurrence wins), together with the source
 * scopes this run could fully enumerate.
 *
 * The sources are what lets the sync distinguish "the source says the user can
 * no longer see this" from "the source's query is not in the cache this run"
 * (a cold start hydrates only a subset), so it never drops a still-valid entry
 * just because its query has not loaded yet. A scope is recorded only by a
 * source that enumerated it completely: an unfiltered list whose page window
 * `maxPages` has not trimmed, or the stored recents list, which is read whole.
 */
export type SystemSearchCollection = {
  documents: SystemSearchDocument[];
  observedSources: Set<string>;
};

/**
 * One query's collected documents, memoized against the payload identity that
 * produced them. `data`, `status` and `maxPages` are exactly the query fields
 * the decode reads, so a change to any of them invalidates the entry and the
 * query is decoded once more.
 */
type QueryCollectionMemo = {
  data: unknown;
  status: Query['state']['status'];
  maxPages: unknown;
  documents: SystemSearchDocument[];
  observedSource: string | null;
};

/**
 * Per-client memo of each cached query's documents, keyed by `queryHash`. Keyed
 * by the client so two clients holding the same query key never read each
 * other's documents (production has one `QueryClient`; the tests build a new
 * one per case), and WeakMap so the memo goes with the client it describes.
 */
const collectionsByClient = new WeakMap<QueryClient, Map<string, QueryCollectionMemo>>();

export async function collectSystemSearchDocuments(
  queryClient: QueryClient
): Promise<SystemSearchCollection> {
  const documents: SystemSearchDocument[] = [];
  const observedSources = new Set<string>();
  const collections = collectionsFor(queryClient);
  const seen = new Set<string>();
  for (const query of queryClient.getQueryCache().getAll()) {
    const queryHash = query.queryHash;
    seen.add(queryHash);
    const collected = collectOrReuse(collections, query, queryHash);
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
  // Drop the queries the cache no longer holds, so a removed-then-re-added
  // query decodes its new payload and the memo stays bounded to the cache.
  for (const queryHash of collections.keys()) {
    if (!seen.has(queryHash)) {
      collections.delete(queryHash);
    }
  }
  const recents = await recentPrDocuments();
  documents.push(...recents.documents);
  for (const source of recents.observedSources) {
    observedSources.add(source);
  }
  return { documents: dedupeBy(documents, document => document.id), observedSources };
}

/** The query memo belonging to one client, created on first use. */
function collectionsFor(queryClient: QueryClient): Map<string, QueryCollectionMemo> {
  const existing = collectionsByClient.get(queryClient);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, QueryCollectionMemo>();
  collectionsByClient.set(queryClient, created);
  return created;
}

/**
 * One query's documents: reused from the memo when the payload identity it
 * decoded is unchanged, decoded and memoized otherwise. `data`, `status` and
 * `maxPages` are the fields the decode reads, so comparing them is enough to
 * know the cached entry describes the query in front of us.
 */
function collectOrReuse(
  collections: Map<string, QueryCollectionMemo>,
  query: Query,
  queryHash: string
): QueryDocuments {
  const memo = collections.get(queryHash);
  if (
    memo !== undefined &&
    memo.data === query.state.data &&
    memo.status === query.state.status &&
    memo.maxPages === query.options.maxPages
  ) {
    // The payload is the same object this entry decoded, so its documents and
    // their fingerprints are reused rather than rebuilt.
    return memo;
  }
  const collected = documentsFromQuery(query);
  collections.set(queryHash, {
    data: query.state.data,
    status: query.state.status,
    maxPages: query.options.maxPages,
    documents: collected.documents,
    observedSource: collected.observedSource,
  });
  return collected;
}

/**
 * What one cached query carries: the documents it enumerates, and the source
 * scope key it fully enumerated, or null when it did not enumerate one. The
 * observed source is non-null only when `data` decoded as that source's list
 * payload, the key input carried no narrowing filter, and the page window was
 * not trimmed, so a probe, a filtered list or a partial window never claims a
 * source.
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
const providerInboxInputSchema = z
  .object({
    platform: z.enum(['gitlab', 'bitbucket']),
    organizationId: z.string().optional(),
  })
  .strict();
const queryInputSchema = z.record(z.string(), z.unknown());
const maxPagesSchema = z.number();
const pagesDataSchema = z.object({ pages: z.array(z.unknown()) });
// The cursor-paginated lists (sessions, both inboxes) hand back the next
// cursor on every page and `null` on the terminal one. The schema demands the
// `null` marker, so a page that advertises a cursor, or carries no cursor field
// at all, parses as "not the end".
const terminalCursorPageSchema = z.object({ nextCursor: z.null() });
// The findings list is offset-paginated: its terminal marker is the page's own
// `totalCount` against the rows loaded so far, not a cursor.
const findingsCountPageSchema = z.object({
  findings: z.array(z.unknown()),
  totalCount: z.number(),
});

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
      observedSource: sessionObservedSource(query),
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
        .map(row => inboxPrSearchDocument(row, systemSearchSourceKey('pullRequests', 'github'))),
      observedSource: isDefaultInput
        ? untrimmedSource(query, systemSearchSourceKey('pullRequests', 'github'), cursorHasMore)
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
    const provider = providerInboxProvider(queryInput(queryKey));
    const organizationId = providerInboxOrganizationId(queryInput(queryKey));
    return {
      documents: parsed.data.pages
        .flatMap(page => decodedRows(page.items, providerInboxItemRowSchema))
        .map(row =>
          providerPrSearchDocument(
            row.ref,
            row.title ?? '',
            providerInboxSourceScope(row.ref.platform, organizationId)
          )
        ),
      observedSource:
        provider === null
          ? null
          : untrimmedSource(
              query,
              providerInboxSourceScope(provider, organizationId),
              cursorHasMore
            ),
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
  return {
    documents: parsed.data.pages
      .flatMap(page => decodedRows(page.findings, findingRowSchema))
      .map(row => findingSearchDocument(row, scope)),
    observedSource: filtered
      ? null
      : untrimmedSource(query, systemSearchSourceKey('findings', scope), findingsHasMore),
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
function sessionObservedSource(query: Query): string | null {
  const input = queryInput(query.queryKey);
  if (hasNarrowingFilter(input, SESSION_NARROWING_KEYS)) {
    return null;
  }
  const scope = sessionScopeInputSchema.safeParse(input);
  const organizationId = scope.success ? scope.data.organizationId : undefined;
  return untrimmedSource(
    query,
    systemSearchSourceKey('sessions', organizationId ?? PERSONAL_SOURCE_SCOPE),
    cursorHasMore
  );
}

/**
 * The candidate source key, or null when the cached pages do not prove the
 * query enumerated the whole source. Two things can make the window partial:
 * a full `maxPages` window may already have evicted its oldest pages, and a
 * last page that advertises a further page means the query stopped early — a
 * refresh then holds only a prefix of the source, so its rows are a subset and
 * its success must not authorise removing the rest.
 */
function untrimmedSource(
  query: Query,
  source: string,
  hasMore: (pages: readonly unknown[]) => boolean
): string | null {
  const bound = maxPagesSchema.safeParse(query.options.maxPages);
  const pages = pagesDataSchema.safeParse(query.state.data);
  if (!pages.success) {
    return null;
  }
  if (bound.success && pages.data.pages.length >= bound.data) {
    return null;
  }
  return hasMore(pages.data.pages) ? null : source;
}

/**
 * Whether a cursor-paginated window stopped before the source's end. The last
 * page's `nextCursor: null` is the terminal marker: a non-null cursor, or a
 * page that carries no cursor field at all, is not evidence the source is
 * fully enumerated.
 */
function cursorHasMore(pages: readonly unknown[]): boolean {
  return !terminalCursorPageSchema.safeParse(pages.at(-1)).success;
}

/**
 * Whether a findings window stopped before the scope's end. The list is
 * offset-paginated and reports the scope's `totalCount`, so the rows loaded
 * across the retained pages are compared against it; a page that omits the
 * count, or a window whose rows fall short of it, is not a complete
 * enumeration.
 */
function findingsHasMore(pages: readonly unknown[]): boolean {
  const last = findingsCountPageSchema.safeParse(pages.at(-1));
  if (!last.success) {
    return true;
  }
  let loaded = 0;
  for (const page of pages) {
    const parsed = findingsCountPageSchema.safeParse(page);
    if (parsed.success) {
      loaded += parsed.data.findings.length;
    }
  }
  return loaded < last.data.totalCount;
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

/** The `platform` a provider inbox query enumerates, or null when filtered. */
function providerInboxProvider(input: QueryInput | null): string | null {
  const parsed = providerInboxInputSchema.safeParse(input);
  return parsed.success ? parsed.data.platform : null;
}

/**
 * The organization a provider inbox query ran under, or undefined for the
 * personal scope. It belongs to the source scope: the same provider's inbox
 * for two organizations is two sources, so one must never authorise removing
 * the other's rows.
 */
function providerInboxOrganizationId(input: QueryInput | null): string | undefined {
  const parsed = providerInboxInputSchema.safeParse(input);
  return parsed.success ? parsed.data.organizationId : undefined;
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

async function recentPrDocuments(): Promise<{
  documents: SystemSearchDocument[];
  observedSources: string[];
}> {
  // SecureStore can fail (locked device, corrupt entry); `undefined` is that
  // failed read, and the index then simply carries no recents and observes no
  // recents scope, so nothing is removed on the strength of a read that did not
  // happen. A read list is read whole, so every provider's recents scope is
  // enumerated this run: an entry that is no longer in the list is genuinely
  // gone, not a source the cache has not hydrated. No inbox query can stand in
  // for this — Bitbucket's inbox is organization-only and GitLab's personal one
  // is absent in an organization context — so a recents entry would otherwise
  // never leave the index.
  const recents = await getRecentPrsForIndex();
  if (recents === undefined) {
    return { documents: [], observedSources: [] };
  }
  return {
    documents: recents.map(entry => recentPrSearchDocument(entry)),
    observedSources: recentPrSourceScopes(),
  };
}

function presentOrEmpty(document: SystemSearchDocument | null): SystemSearchDocument[] {
  return document === null ? [] : [document];
}
