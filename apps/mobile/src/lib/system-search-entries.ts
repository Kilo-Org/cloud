/* eslint-disable max-lines -- one module owns the document builders, the route allowlist, and the diff plan they feed */
/**
 * Index documents for the phone's own search (Spotlight on iOS, app search
 * on Android), built from rows the app has already fetched.
 *
 * Pure: no React, no react-query, no network. The collectors in
 * `system-search-collect.ts` turn cached query data into these documents,
 * `planSystemSearchUpdate` says what changed, and the platform bridge
 * consumes the result.
 *
 * The document `id` IS the in-app route the result opens — built by the
 * app's own route builders, never a hand-built string — so an id can never
 * describe a screen the app cannot show. `route` is that same id as the link
 * the OS hands back when the result is picked.
 */

import { z } from 'zod';

import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import {
  githubPrRef,
  providerPrNumber,
  type ProviderPrRef,
  providerPrRefLabel,
  providerPrRepoPath,
  providerPrRoutePath,
} from '@/lib/pr-review/provider-pr-ref';
import { providerRefFromRecentPr, type RecentPrRef } from '@/lib/pr-review/recent-prs';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { isPlaceholderSessionTitle } from '@/lib/session-display-title';

import {
  APP_SCHEME,
  deeplinkPathFromHref,
  FINDING_HREF_PREFIX,
  PULL_REQUEST_HREF_PREFIX,
  SESSION_HREF_PREFIX,
} from './system-search-families';

/** One indexed entity, in the shape the platform bridge takes. */
export type SystemSearchDocument = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /**
   * The OS-facing link for this entry, built from `id` by
   * `systemSearchDeeplinkFromId`. The Android module stores it and hands it
   * back when the entry is picked; iOS ignores it and returns `id`.
   */
  route: string;
  /**
   * Stable JSON of the content fields and the route. It changes when title,
   * description, keywords or the route change and never otherwise, so a
   * renamed row is re-indexed, an entry indexed before the route existed is
   * re-indexed, and an unrelated re-render is not.
   */
  fingerprint: string;
};

/** The route families an indexed id can name, one per source the app indexes. */
export type SystemSearchFamily = 'sessions' | 'pullRequests' | 'findings';

/**
 * The three route groups an indexed id is allowed to name, with the source
 * family each belongs to. The family lets the sync keep an indexed id whose
 * source could not be enumerated this run (a cold start hydrates only some
 * queries), so a valid entry is not dropped just because its query is absent.
 */
const HREF_FAMILIES: readonly { prefix: string; family: SystemSearchFamily }[] = [
  { prefix: SESSION_HREF_PREFIX, family: 'sessions' },
  { prefix: PULL_REQUEST_HREF_PREFIX, family: 'pullRequests' },
  { prefix: FINDING_HREF_PREFIX, family: 'findings' },
];

/** The route groups an indexed id is allowed to name. */
const HREF_PREFIXES = HREF_FAMILIES.map(entry => entry.prefix);

/**
 * The exact shapes the three route groups may take, one segment token at a
 * time: a non-empty segment that is never `.` or `..`, so an id carrying a
 * traversal segment or an extra one cannot pass the allowlist and be handed to
 * `router.navigate` verbatim. `agent-chat` is one segment; `pr-review` nests
 * for GitLab project paths; a finding is `<scope>/findings/<id>`.
 */
const ID_SEGMENT = String.raw`(?!\.\.?(?:[/?#]|$))[^/?#]+`;

const ROUTE_ID_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`^/\(app\)/agent-chat/${ID_SEGMENT}(?:\?[^#]*)?$`),
  new RegExp(String.raw`^/\(app\)/pr-review/${ID_SEGMENT}(?:/${ID_SEGMENT})*(?:\?[^#]*)?$`),
  new RegExp(
    String.raw`^/\(app\)/\(tabs\)/\(3_profile\)/security-agent/${ID_SEGMENT}/findings/${ID_SEGMENT}(?:\?[^#]*)?$`
  ),
];

type DocumentContent = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /**
   * The source scope this document was enumerated from, when the id alone
   * cannot name it. A provider pull-request route carries the provider but not
   * the organization its inbox ran under, so the source rides in the
   * fingerprint — the one ownership field the platform index stores beside the
   * id — and `planSystemSearchUpdate` reads it back to match the entry to the
   * scope that may remove it.
   */
  source?: string;
};

function buildDocument(input: DocumentContent): SystemSearchDocument {
  const keywords = input.keywords.filter(keyword => keyword.length > 0);
  // Every builder hands `buildDocument` the output of the app's own route
  // builder, so `id` is always an id the allowlist knows and the link is
  // always built; the id stays the fallback for the day it is not.
  const route = systemSearchDeeplinkFromId(input.id) ?? input.id;
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    keywords,
    route,
    fingerprint: JSON.stringify({
      title: input.title,
      description: input.description,
      keywords,
      route,
      ...(input.source === undefined ? {} : { source: input.source }),
    }),
  };
}

// ── sessions ───────────────────────────────────────────────────────────────

/** A stored-history (`cliSessionsV2.list`) session row. */
export type SystemSearchStoredSessionRow = {
  session_id: string;
  title?: string | null;
  organization_id?: string | null;
  git_branch?: string | null;
};

/** A live (`activeSessions.list`) session row. */
export type SystemSearchActiveSessionRow = {
  id: string;
  title?: string | null;
  organizationId?: string | null;
  gitBranch?: string | null;
};

/**
 * The stored-history document for one session, or null when it has no title.
 *
 * The app paints `agents.sessionRow.untitled` for a title-less session, so
 * indexing it would add one identical translated label per untitled row.
 */
export function storedSessionSearchDocument(
  row: SystemSearchStoredSessionRow
): SystemSearchDocument | null {
  return sessionSearchDocument({
    sessionId: row.session_id,
    title: row.title,
    organizationId: row.organization_id,
    gitBranch: row.git_branch,
  });
}

/** The live-session document for one session, or null when it has no title. */
export function activeSessionSearchDocument(
  row: SystemSearchActiveSessionRow
): SystemSearchDocument | null {
  // `undefined` means the row was inserted by the WS push path, which cannot
  // carry an organization. `filterActiveSessionsByOrganization` hides such a
  // row in every filtered context and only `null` means personal, so indexing
  // it would put an org session's live row under a personal route under a
  // different id than the later tRPC-attributed row. Skip it until the next
  // fetch attributes it.
  if (row.organizationId === undefined) {
    return null;
  }
  return sessionSearchDocument({
    sessionId: row.id,
    title: row.title,
    organizationId: row.organizationId,
    gitBranch: row.gitBranch,
  });
}

function sessionSearchDocument(input: {
  sessionId: string;
  title: string | null | undefined;
  organizationId?: string | null;
  gitBranch?: string | null;
}): SystemSearchDocument | null {
  const title = (input.title ?? '').trim();
  if (isPlaceholderSessionTitle(title)) {
    return null;
  }
  return buildDocument({
    // The route builder carries the organization context, so an org-scoped
    // session keeps its `organizationId` in the id.
    id: getAgentSessionPath(input.sessionId, input.organizationId ?? undefined) as string,
    title,
    description: input.gitBranch ?? '',
    keywords: [],
  });
}

// ── pull requests ──────────────────────────────────────────────────────────

/** A `githubPrReview.listInbox` item. */
export type SystemSearchInboxPrRow = {
  owner: string;
  repo: string;
  number: number;
  title?: string | null;
};

/** A `getRecentPrs()` entry. */
export type SystemSearchRecentPrRow = RecentPrRef & { title: string };

/** The document for one inbox row, enumerated from `source` when given. */
export function inboxPrSearchDocument(
  row: SystemSearchInboxPrRow,
  source?: string
): SystemSearchDocument {
  return providerPrSearchDocument(
    githubPrRef(row.owner, row.repo, row.number),
    row.title ?? '',
    source
  );
}

/**
 * The document for one recents entry. Recents keep their provider (s7), so a
 * GitLab or Bitbucket entry routes through its own provider route.
 *
 * Recents carry no organization: the entry is account-level, so its source is
 * the recents list itself, one scope per provider. No inbox query can speak for
 * every recents entry — Bitbucket's inbox is organization-only and GitLab's
 * personal one is absent in an organization context — so the collector observes
 * the recents scopes from its own read of the list. An entry the user removed,
 * or one evicted by newer opens, then leaves the index; a provider inbox
 * enumeration never authorises that removal.
 */
export function recentPrSearchDocument(row: SystemSearchRecentPrRow): SystemSearchDocument {
  const platform = row.platform ?? 'github';
  return providerPrSearchDocument(
    providerRefFromRecentPr(row),
    row.title,
    recentsSourceScope(platform)
  );
}

/** The providers the stored recents list can carry, so one read enumerates them all. */
const RECENT_PR_PLATFORMS = ['github', 'gitlab', 'bitbucket'] as const;

/** The account-level recents list's scope name, distinct from any inbox scope. */
const RECENTS_SOURCE_SCOPE = 'recents';

/**
 * The source scope the stored recents list enumerates for one provider. The
 * `recents` segment keeps it distinct from every inbox scope, so a provider
 * inbox enumeration never authorises removing an entry the recents still carry.
 */
export function recentsSourceScope(platform: string): string {
  return systemSearchSourceKey('pullRequests', `${platform}:${RECENTS_SOURCE_SCOPE}`);
}

/**
 * Every source scope a fully-read recents list enumerates. The list is
 * account-level and read whole, so a provider with no entry in it is genuinely
 * absent rather than a query the cache has not hydrated yet, and each provider's
 * scope is observed from that one read.
 */
export function recentPrSourceScopes(): string[] {
  return RECENT_PR_PLATFORMS.map(platform => recentsSourceScope(platform));
}

/**
 * The shared PR document for one provider ref. The GitHub inbox, the stored
 * recents and the GitLab/Bitbucket provider inbox all funnel through this one
 * builder, so a PR/MR the user already has is indexed under one document
 * shape whichever cache carried it in — and the dedupe by id in the collector
 * sees one entry, not two. `source` is the scope that enumerated the row, kept
 * in the fingerprint so removal stays scoped to that scope.
 */
export function providerPrSearchDocument(
  ref: ProviderPrRef,
  title: string,
  source?: string
): SystemSearchDocument {
  return buildDocument({
    id: providerPrRoutePath(ref) as string,
    title,
    description: providerPrRefLabel(ref),
    keywords: [providerPrRepoPath(ref), String(providerPrNumber(ref))],
    ...(source === undefined ? {} : { source }),
  });
}

/**
 * The source scope one provider inbox enumerated: the provider plus the
 * organization the query ran under (the personal scope when it named none), so
 * an authoritative GitLab or Bitbucket cache for one organization never speaks
 * for another organization's rows.
 */
export function providerInboxSourceScope(
  provider: string,
  organizationId: string | null | undefined
): string {
  return systemSearchSourceKey(
    'pullRequests',
    organizationId ? `${provider}:${organizationId}` : `${provider}:${PERSONAL_SOURCE_SCOPE}`
  );
}

// ── security findings ──────────────────────────────────────────────────────

/** A `securityAgent.listFindings` / `organizations.securityAgent.listFindings` row. */
export type SystemSearchFindingRow = {
  id: string;
  title?: string | null;
  severity?: string | null;
  repo_full_name?: string | null;
};

/** The document for one finding, scoped to the personal or organization surface. */
export function findingSearchDocument(
  row: SystemSearchFindingRow,
  scope: string
): SystemSearchDocument {
  const repo = row.repo_full_name ?? '';
  const severity = row.severity ?? '';
  return buildDocument({
    id: getSecurityAgentPath(scope, `findings/${row.id}`) as string,
    title: row.title ?? '',
    description: [repo, severity].filter(part => part.length > 0).join(' · '),
    keywords: [repo, severity],
  });
}

// ── identifiers back to routes ─────────────────────────────────────────────

/**
 * The in-app route an indexed id names, or null when it is not an id this
 * section issued. The three known route shapes are the only allowlist, so an
 * unrecognised identifier — a stale index, a hand-made deeplink — can never
 * navigate.
 */
export function systemSearchHrefFromId(id: string): string | null {
  const known = ROUTE_ID_PATTERNS.some(pattern => pattern.test(id));
  return known ? id : null;
}

/** The personal scope name shared by the session and finding sources. */
export const PERSONAL_SOURCE_SCOPE = 'personal';

/**
 * The evidence key for one fully enumerated source: a family plus the scope
 * within it — the personal scope, one organization, or one pull-request
 * provider. Two queries that enumerate different scopes of a family (the
 * personal findings list and an organization's, or the GitHub inbox and the
 * GitLab one) must not authorise each other's removals, so the plan matches an
 * indexed id against the key of the scope it actually belongs to rather than
 * against a family-wide flag.
 */
export function systemSearchSourceKey(family: SystemSearchFamily, scope: string): string {
  return `${family}:${scope}`;
}

/**
 * The source keys whose full enumeration authorises removing one indexed id,
 * or an empty list when the id is not one this section issued. The scope is
 * read back out of the id the app's route builders produced: a session's
 * `organizationId` parameter, a pull request's provider segment, or a
 * finding's scope segment. The sync removes an indexed entry only when its own
 * source was enumerated this run, so an id whose query is not in the cache (a
 * cold start hydrates only some queries) is left in place.
 */
export function systemSearchSourceKeysOfId(id: string): string[] {
  if (systemSearchHrefFromId(id) === null) {
    return [];
  }
  if (id.startsWith(SESSION_HREF_PREFIX)) {
    return [
      systemSearchSourceKey('sessions', organizationIdOfSessionId(id) ?? PERSONAL_SOURCE_SCOPE),
    ];
  }
  if (id.startsWith(PULL_REQUEST_HREF_PREFIX)) {
    return [systemSearchSourceKey('pullRequests', providerOfPullRequestId(id))];
  }
  if (id.startsWith(FINDING_HREF_PREFIX)) {
    const scope = findingScopeOfId(id);
    return scope === null ? [] : [systemSearchSourceKey('findings', scope)];
  }
  return [];
}

const ORGANIZATION_ID_IN_ID = /[?&]organizationId=([^&#]*)/;

/** The `organizationId` an indexed session id carries, or null for personal. */
function organizationIdOfSessionId(id: string): string | null {
  const encoded = ORGANIZATION_ID_IN_ID.exec(id)?.[1];
  if (encoded === undefined) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    // A malformed percent-escape means the id cannot name a real scope.
    return null;
  }
}

/**
 * The provider an indexed pull-request id belongs to. A GitHub id is
 * `<owner>/<repo>/<number>` and carries no platform segment, so anything that
 * is not the `gitlab`/`bitbucket` discriminator is GitHub; misreading a GitHub
 * repo literally named `gitlab` only ever keeps an entry longer.
 */
function providerOfPullRequestId(id: string): string {
  const first = id.slice(PULL_REQUEST_HREF_PREFIX.length).split(/[/?#]/, 1)[0] ?? '';
  return first === 'gitlab' || first === 'bitbucket' ? first : 'github';
}

/** The `personal`/organization scope segment of an indexed finding id. */
function findingScopeOfId(id: string): string | null {
  const first = id.slice(FINDING_HREF_PREFIX.length).split('/', 1)[0] ?? '';
  return first.length > 0 ? first : null;
}

/**
 * The id as a link the OS can hand back to the app. Expo Router groups
 * (`(app)`, `(tabs)/(3_profile)`) are app-internal and never appear in a
 * deeplink, so they are stripped; null for an unrecognised id.
 */
export function systemSearchDeeplinkFromId(id: string): string | null {
  if (systemSearchHrefFromId(id) === null) {
    return null;
  }
  return `${APP_SCHEME}${deeplinkPathFromHref(id)}`;
}

/**
 * The in-app route a result the OS handed back names: the bare id iOS returns
 * from `consumePendingRoute`, or the `kiloapp://` link the Android module
 * stores as the document's `route`. Null for anything else — a stale index or
 * a hand-made link — so an identifier can only ever navigate to one of the
 * three screens this section issued.
 *
 * The shared universal-link table cannot do this: it maps web paths, and two
 * of the three shapes here (`/agent-chat/...`, `/security-agent/...`) are not
 * rows in it. The inverse of `systemSearchDeeplinkFromId` is exact instead.
 */
export function systemSearchHrefFromRoute(route: string): string | null {
  const href = systemSearchHrefFromId(route);
  if (href !== null) {
    return href;
  }
  if (!route.startsWith(APP_SCHEME)) {
    return null;
  }
  const path = route.slice(APP_SCHEME.length);
  for (const prefix of HREF_PREFIXES) {
    const linkPrefix = deeplinkPathFromHref(prefix);
    if (path.startsWith(linkPrefix)) {
      // `systemSearchHrefFromId` rejects the prefix alone, so a link that
      // names no entry stays unroutable.
      return systemSearchHrefFromId(`${prefix}${path.slice(linkPrefix.length)}`);
    }
  }
  return null;
}

// ── the diff ───────────────────────────────────────────────────────────────

/** The work one index refresh must do. */
export type SystemSearchUpdatePlan = {
  add: SystemSearchDocument[];
  remove: string[];
};

/**
 * What the indexer must do to move from `indexed` to `documents`.
 *
 * Documents are deduped by id (first occurrence wins, matching the app's own
 * row order). A document is added when its id is unknown or its fingerprint
 * changed. An indexed id is removed only when the documents no longer carry it
 * AND its own source scope was fully enumerated this run: the react-query cache
 * is the only evidence the app has, and a cold start hydrates a subset of the
 * source queries, so an id whose query is simply absent must stay rather than
 * be dropped as if the user could no longer see it. This is still how an item
 * the user can no longer see leaves the index — its source was enumerated, so
 * its absence is evidence, not ignorance.
 */
export function planSystemSearchUpdate(input: {
  indexed: readonly SystemSearchDocument[];
  documents: readonly SystemSearchDocument[];
  /** The source scopes the current run could fully enumerate from the cache. */
  observedSources: ReadonlySet<string>;
}): SystemSearchUpdatePlan {
  const indexedById = indexById(input.indexed);
  const documentsById = indexById(input.documents);
  const add: SystemSearchDocument[] = [];
  for (const [id, document] of documentsById) {
    const current = indexedById.get(id);
    if (!current || current.fingerprint !== document.fingerprint) {
      add.push(document);
    }
  }
  const remove = [...indexedById.values()]
    .filter(document => {
      if (documentsById.has(document.id)) {
        return false;
      }
      return sourceKeysOfIndexedDocument(document).some(source =>
        input.observedSources.has(source)
      );
    })
    .map(document => document.id);
  return { add, remove };
}

/**
 * The source scopes that may remove one indexed document. A document whose
 * fingerprint names its own source (a provider pull request) is matched on
 * that source alone: the route cannot say which organization the inbox ran
 * under, so inferring the scope from the id would let one organization's cache
 * remove another organization's rows. Every other document — a session or a
 * finding, whose id already carries its scope — falls back to the id.
 */
function sourceKeysOfIndexedDocument(document: SystemSearchDocument): string[] {
  const embedded = fingerprintSource(document.fingerprint);
  return embedded === null ? systemSearchSourceKeysOfId(document.id) : [embedded];
}

/** The source scope a document's fingerprint carries, or null when it names none. */
function fingerprintSource(fingerprint: string): string | null {
  try {
    const parsed = fingerprintSourceSchema.safeParse(JSON.parse(fingerprint));
    return parsed.success ? parsed.data.source : null;
  } catch {
    // A fingerprint this module did not write names no source.
    return null;
  }
}

// A fingerprint without a non-empty `source` names none, so the id-derived
// scope still governs.
const fingerprintSourceSchema = z.object({ source: z.string().min(1) });

function indexById(documents: readonly SystemSearchDocument[]): Map<string, SystemSearchDocument> {
  const byId = new Map<string, SystemSearchDocument>();
  for (const document of documents) {
    if (!byId.has(document.id)) {
      byId.set(document.id, document);
    }
  }
  return byId;
}
