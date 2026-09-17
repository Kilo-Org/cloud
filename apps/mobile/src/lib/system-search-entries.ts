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

/** The route groups an indexed id is allowed to name. */
const HREF_PREFIXES = [
  '/(app)/agent-chat/',
  '/(app)/pr-review/',
  '/(app)/(tabs)/(3_profile)/security-agent/',
] as const;

/** The app-scheme prefix every deeplink carries. */
const APP_SCHEME = 'kiloapp://';

/** The group segments a deeplink drops: `(app)` and the profile tab group. */
const APP_GROUP_PREFIX = '/(app)/';
const PROFILE_TABS_GROUP_PREFIX = '(tabs)/(3_profile)/';

type DocumentContent = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
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
  if (title.length === 0) {
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

/** The document for one inbox row. */
export function inboxPrSearchDocument(row: SystemSearchInboxPrRow): SystemSearchDocument {
  return providerPrSearchDocument(githubPrRef(row.owner, row.repo, row.number), row.title ?? '');
}

/**
 * The document for one recents entry. Recents keep their provider (s7), so a
 * GitLab or Bitbucket entry routes through its own provider route.
 */
export function recentPrSearchDocument(row: SystemSearchRecentPrRow): SystemSearchDocument {
  return providerPrSearchDocument(providerRefFromRecentPr(row), row.title);
}

/**
 * The shared PR document for one provider ref. The GitHub inbox, the stored
 * recents and the GitLab/Bitbucket provider inbox all funnel through this one
 * builder, so a PR/MR the user already has is indexed under one document
 * shape whichever cache carried it in — and the dedupe by id in the collector
 * sees one entry, not two.
 */
export function providerPrSearchDocument(ref: ProviderPrRef, title: string): SystemSearchDocument {
  return buildDocument({
    id: providerPrRoutePath(ref) as string,
    title,
    description: providerPrRefLabel(ref),
    keywords: [providerPrRepoPath(ref), String(providerPrNumber(ref))],
  });
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
  const known = HREF_PREFIXES.some(prefix => id.startsWith(prefix) && id.length > prefix.length);
  return known ? id : null;
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

/** An in-app href with the app-internal group segments dropped. */
function deeplinkPathFromHref(href: string): string {
  const withoutAppGroup = href.slice(APP_GROUP_PREFIX.length);
  return withoutAppGroup.startsWith(PROFILE_TABS_GROUP_PREFIX)
    ? withoutAppGroup.slice(PROFILE_TABS_GROUP_PREFIX.length)
    : withoutAppGroup;
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
 * changed; every indexed id the documents no longer carry is removed, which
 * is how an item the user can no longer see leaves the index.
 */
export function planSystemSearchUpdate(input: {
  indexed: readonly SystemSearchDocument[];
  documents: readonly SystemSearchDocument[];
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
  const remove = [...indexedById.keys()].filter(id => !documentsById.has(id));
  return { add, remove };
}

function indexById(documents: readonly SystemSearchDocument[]): Map<string, SystemSearchDocument> {
  const byId = new Map<string, SystemSearchDocument>();
  for (const document of documents) {
    if (!byId.has(document.id)) {
      byId.set(document.id, document);
    }
  }
  return byId;
}
