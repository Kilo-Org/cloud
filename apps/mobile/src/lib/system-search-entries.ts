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
 * describe a screen the app cannot show.
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
   * Stable JSON of the content fields. It changes when title, description or
   * keywords change and never otherwise, so a renamed row is re-indexed and
   * an unrelated re-render is not.
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
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    keywords,
    fingerprint: JSON.stringify({
      title: input.title,
      description: input.description,
      keywords,
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
  return prSearchDocument({
    ref: githubPrRef(row.owner, row.repo, row.number),
    title: row.title ?? '',
  });
}

/**
 * The document for one recents entry. Recents keep their provider (s7), so a
 * GitLab or Bitbucket entry routes through its own provider route.
 */
export function recentPrSearchDocument(row: SystemSearchRecentPrRow): SystemSearchDocument {
  return prSearchDocument({ ref: providerRefFromRecentPr(row), title: row.title });
}

function prSearchDocument(input: { ref: ProviderPrRef; title: string }): SystemSearchDocument {
  return buildDocument({
    id: providerPrRoutePath(input.ref) as string,
    title: input.title,
    description: providerPrRefLabel(input.ref),
    keywords: [providerPrRepoPath(input.ref), String(providerPrNumber(input.ref))],
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
  const withoutAppGroup = id.slice(APP_GROUP_PREFIX.length);
  const path = withoutAppGroup.startsWith(PROFILE_TABS_GROUP_PREFIX)
    ? withoutAppGroup.slice(PROFILE_TABS_GROUP_PREFIX.length)
    : withoutAppGroup;
  return `${APP_SCHEME}${path}`;
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
