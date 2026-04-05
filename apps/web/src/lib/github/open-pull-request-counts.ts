import 'server-only';

import * as z from 'zod';
import { fetchWithBackoff } from '@/lib/fetchWithBackoff';
import { GITHUB_ADMIN_STATS_TOKEN } from '@/lib/config.server';

type OpenPullRequestCounts = {
  totalOpenPullRequests: number;
  teamOpenPullRequests: number;
  externalOpenPullRequests: number;
  updatedAt: string;
};

export type { OpenPullRequestCounts };

export type PullRequestReviewStatus = 'changes_requested' | 'approved' | 'commented' | 'no_reviews';

type ExternalOpenPullRequest = {
  number: number;
  title: string;
  url: string;
  repo: string;
  authorLogin: string;
  createdAt: string;
  ageDays: number;
  commentCount: number;
  teamCommented: boolean;
  reviewStatus: PullRequestReviewStatus;
};

type OpenPullRequestsSummary = OpenPullRequestCounts & {
  externalOpenPullRequestsList: ExternalOpenPullRequest[];
};

export type { ExternalOpenPullRequest, OpenPullRequestsSummary };

type ExternalMergedPullRequest = {
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  mergedAt: string;
};

export type { ExternalMergedPullRequest };

type ExternalClosedPullRequestStatus = 'merged' | 'closed';

type ExternalClosedPullRequest = {
  number: number;
  title: string;
  url: string;
  repo: string;
  authorLogin: string;
  closedAt: string;
  mergedAt: string | null;
  status: ExternalClosedPullRequestStatus;
  displayDate: string;
};

export type { ExternalClosedPullRequest, ExternalClosedPullRequestStatus };

type ExternalClosedPullRequestsWithWeekStats = {
  prs: ExternalClosedPullRequest[];
  thisWeekMergedCount: number;
  thisWeekClosedCount: number;
  weekStart: string;
  weekEnd?: string;
};

export type { ExternalClosedPullRequestsWithWeekStats };

type CacheEntry<T> = {
  value: T;
  expiresAtMs: number;
};

type IsoWeekBounds = {
  weekStart: Date;
  weekEnd: Date;
};

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const byType = new Map<string, string>();
  for (const part of parts) {
    if (part.type === 'literal') continue;
    byType.set(part.type, part.value);
  }

  const year = Number(byType.get('year'));
  const month = Number(byType.get('month'));
  const day = Number(byType.get('day'));
  const hour = Number(byType.get('hour'));
  const minute = Number(byType.get('minute'));
  const second = Number(byType.get('second'));

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    throw new Error('Failed to derive zoned date parts');
  }

  return { year, month, day, hour, minute, second };
}

function getTimeZoneOffsetMs(timeZone: string, date: Date): number {
  const zoned = getZonedDateParts(date, timeZone);
  const zonedAsUtcMs = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second
  );
  return zonedAsUtcMs - date.getTime();
}

function zonedDateTimeToUtcDate(parts: ZonedDateParts, timeZone: string): Date {
  const utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  let candidateMs = utcMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMs = getTimeZoneOffsetMs(timeZone, new Date(candidateMs));
    const adjustedMs = utcMs - offsetMs;
    if (adjustedMs === candidateMs) break;
    candidateMs = adjustedMs;
  }

  return new Date(candidateMs);
}

export function getCurrentIsoWeekBoundsInTimeZone(options: {
  now: Date;
  timeZone: string;
}): IsoWeekBounds {
  const { now, timeZone } = options;

  const zonedNow = getZonedDateParts(now, timeZone);
  const localDateUtc = new Date(Date.UTC(zonedNow.year, zonedNow.month - 1, zonedNow.day));

  // ISO week: Monday=1, Sunday=7
  const dayOfWeek = localDateUtc.getUTCDay();
  const isoDayOfWeek = ((dayOfWeek + 6) % 7) + 1;

  const startLocalDateUtcMs = localDateUtc.getTime() - (isoDayOfWeek - 1) * 24 * 60 * 60_000;
  const startLocalDateUtc = new Date(startLocalDateUtcMs);

  const weekStart = zonedDateTimeToUtcDate(
    {
      year: startLocalDateUtc.getUTCFullYear(),
      month: startLocalDateUtc.getUTCMonth() + 1,
      day: startLocalDateUtc.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );

  const endLocalDateUtcMs = startLocalDateUtcMs + 7 * 24 * 60 * 60_000;
  const endLocalDateUtc = new Date(endLocalDateUtcMs);

  const weekEnd = zonedDateTimeToUtcDate(
    {
      year: endLocalDateUtc.getUTCFullYear(),
      month: endLocalDateUtc.getUTCMonth() + 1,
      day: endLocalDateUtc.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );

  return { weekStart, weekEnd };
}

export function isIsoTimestampWithinBounds(iso: string, bounds: IsoWeekBounds): boolean {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) return false;
  return time >= bounds.weekStart.getTime() && time < bounds.weekEnd.getTime();
}

type GithubUserLite = {
  login: string;
  type?: string;
};

function toGithubUserLite(user: { login: string; type?: string | undefined }): GithubUserLite {
  return user.type === undefined ? { login: user.login } : { login: user.login, type: user.type };
}

const PULL_REQUEST_AUTHOR_SCHEMA = z.object({
  // Draft PRs should be excluded by default from our admin stats, but we still parse
  // this field so callers can optionally include them.
  draft: z.boolean().optional().default(false),
  user: z
    .object({
      login: z.string().min(1),
      // GitHub REST user objects include `type` (e.g. "User" | "Bot" | "Organization").
      // Treat it as optional to avoid breaking if the API adds new values or omits it.
      type: z.string().min(1).optional(),
    })
    .nullable(),
});

const LIST_PULL_REQUESTS_RESPONSE_SCHEMA = z.array(PULL_REQUEST_AUTHOR_SCHEMA);

const LIST_PULL_REQUESTS_SUMMARY_ITEM_SCHEMA = z.object({
  number: z.number().int().nonnegative(),
  title: z.string(),
  html_url: z.string().url(),
  created_at: z.string(),
  // Draft PRs should be excluded by default from our admin stats, but we still parse
  // this field so callers can optionally include them.
  draft: z.boolean().optional().default(false),
  // GitHub REST API sometimes omits these fields depending on endpoint/preview behavior.
  // Default them to 0 so downstream code always has numeric comment counts.
  comments: z.number().int().nonnegative().default(0),
  review_comments: z.number().int().nonnegative().default(0),
  user: z
    .object({
      login: z.string().min(1),
      // GitHub REST user objects include `type` (e.g. "User" | "Bot" | "Organization").
      // Treat it as optional to avoid breaking if the API adds new values or omits it.
      type: z.string().min(1).optional(),
    })
    .nullable(),
});

const LIST_PULL_REQUESTS_SUMMARY_RESPONSE_SCHEMA = z.array(LIST_PULL_REQUESTS_SUMMARY_ITEM_SCHEMA);

const ISSUE_COMMENT_SCHEMA = z.object({
  user: z
    .object({
      login: z.string().min(1),
    })
    .nullable(),
});

const ISSUE_COMMENTS_RESPONSE_SCHEMA = z.array(ISSUE_COMMENT_SCHEMA);

const REVIEW_COMMENT_SCHEMA = z.object({
  user: z
    .object({
      login: z.string().min(1),
    })
    .nullable(),
});

const REVIEW_COMMENTS_RESPONSE_SCHEMA = z.array(REVIEW_COMMENT_SCHEMA);

const PULL_REQUEST_REVIEW_SCHEMA = z.object({
  state: z.string().min(1),
  user: z
    .object({
      login: z.string().min(1),
    })
    .nullable(),
});

const PULL_REQUEST_REVIEWS_RESPONSE_SCHEMA = z.array(PULL_REQUEST_REVIEW_SCHEMA);

const CLOSED_PULL_REQUEST_ITEM_SCHEMA = z.object({
  number: z.number().int().nonnegative(),
  title: z.string(),
  html_url: z.string().url(),
  closed_at: z.string().nullable(),
  merged_at: z.string().nullable(),
  user: z
    .object({
      login: z.string().min(1),
      type: z.string().min(1).optional(),
    })
    .nullable(),
});

const CLOSED_PULL_REQUESTS_RESPONSE_SCHEMA = z.array(CLOSED_PULL_REQUEST_ITEM_SCHEMA);

const ORG = 'Kilo-Org';

export const SUPPORTED_REPOS = {
  kilocode: { owner: 'Kilo-Org', name: 'kilocode' },
  cloud: { owner: 'Kilo-Org', name: 'cloud' },
  'kilo-marketplace': { owner: 'Kilo-Org', name: 'kilo-marketplace' },
  'kilocode-legacy': { owner: 'Kilo-Org', name: 'kilocode-legacy' },
} as const;

export type RepoId = keyof typeof SUPPORTED_REPOS;

export const ALL_REPO_IDS: readonly RepoId[] = Object.keys(SUPPORTED_REPOS) as RepoId[];

type RepoRef = { owner: string; name: string };

const countsCacheByKey = new Map<string, CacheEntry<OpenPullRequestCounts>>();
const countsInFlightByKey = new Map<string, Promise<OpenPullRequestCounts>>();

const summaryCacheByKey = new Map<string, CacheEntry<OpenPullRequestsSummary>>();
const summaryInFlightByKey = new Map<string, Promise<OpenPullRequestsSummary>>();

const orgMembersCache = new Map<string, CacheEntry<Set<string>>>();
const orgMembersInFlight = new Map<string, Promise<Set<string>>>();

type PullRequestTeamInteraction = {
  teamCommented: boolean;
  reviewStatus: PullRequestReviewStatus;
};

const DEFAULT_TTL_MS = 2 * 60_000;
const ORG_MEMBERS_TTL_MS = 30 * 60_000;
const TEAM_COMMENTED_TTL_MS = 10 * 60_000;
const teamCommentedCache = new Map<string, CacheEntry<PullRequestTeamInteraction>>();

function isBotGithubUser(user: GithubUserLite): boolean {
  return user.type === 'Bot';
}

function getGithubTokenOrThrow(): string {
  if (!GITHUB_ADMIN_STATS_TOKEN) {
    throw new Error(
      'Missing env var GITHUB_ADMIN_STATS_TOKEN; required for admin GitHub PR counts.'
    );
  }
  return GITHUB_ADMIN_STATS_TOKEN;
}

async function githubRequest(url: string, init?: RequestInit): Promise<Response> {
  const token = getGithubTokenOrThrow();
  return fetchWithBackoff(
    url,
    {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init?.headers ?? {}),
      },
    },
    {
      retryResponse: r => r.status === 429 || r.status >= 500,
      maxDelayMs: 10_000,
    }
  );
}

async function listOpenPullRequestAuthors(options: {
  repo: RepoRef;
  includeDrafts: boolean;
}): Promise<GithubUserLite[]> {
  const perPage = 100;
  const authors: GithubUserLite[] = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/pulls`
    );
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url.toString());
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `GitHub list pulls failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
      );
    }

    const json = LIST_PULL_REQUESTS_RESPONSE_SCHEMA.parse(await response.json());
    for (const pr of json) {
      if (pr.draft && !options.includeDrafts) continue;
      const user = pr.user;
      if (user) authors.push(toGithubUserLite(user));
    }

    if (json.length < perPage) {
      return authors;
    }
  }
}

export type OpenPullRequestApiSummary = z.infer<typeof LIST_PULL_REQUESTS_SUMMARY_ITEM_SCHEMA>;

export function parseGithubListPullRequestsSummaryResponse(
  json: unknown
): OpenPullRequestApiSummary[] {
  return LIST_PULL_REQUESTS_SUMMARY_RESPONSE_SCHEMA.parse(json);
}

async function listOpenPullRequests(options: {
  repo: RepoRef;
  includeDrafts: boolean;
}): Promise<OpenPullRequestApiSummary[]> {
  const perPage = 100;
  const prs: OpenPullRequestApiSummary[] = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/pulls`
    );
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url.toString());
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `GitHub list pulls failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
      );
    }

    const json = parseGithubListPullRequestsSummaryResponse(await response.json());
    if (options.includeDrafts) {
      prs.push(...json);
    } else {
      prs.push(...json.filter(pr => !pr.draft));
    }

    if (json.length < perPage) {
      return prs;
    }
  }
}

const ORG_MEMBERS_SCHEMA = z.array(
  z.object({
    login: z.string().min(1),
  })
);

async function fetchOrgMembers(org: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = orgMembersCache.get(org);
  if (cached && cached.expiresAtMs > now) {
    return cached.value;
  }

  const inFlight = orgMembersInFlight.get(org);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const perPage = 100;
    const logins = new Set<string>();

    for (let page = 1; ; page += 1) {
      const url = new URL(`https://api.github.com/orgs/${encodeURIComponent(org)}/members`);
      url.searchParams.set('per_page', String(perPage));
      url.searchParams.set('page', String(page));

      const response = await githubRequest(url.toString(), { method: 'GET' });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(
          `GitHub list org members failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
        );
      }

      const members = ORG_MEMBERS_SCHEMA.parse(await response.json());
      for (const member of members) {
        logins.add(member.login.toLowerCase());
      }

      if (members.length < perPage) break;
    }

    orgMembersCache.set(org, { value: logins, expiresAtMs: Date.now() + ORG_MEMBERS_TTL_MS });
    return logins;
  })();

  orgMembersInFlight.set(org, promise);

  try {
    return await promise;
  } finally {
    orgMembersInFlight.delete(org);
  }
}

async function isOrgMember(org: string, username: string): Promise<boolean> {
  const members = await fetchOrgMembers(org);
  return members.has(username.toLowerCase());
}

function msBetween(earlier: Date, later: Date): number {
  return later.getTime() - earlier.getTime();
}

function daysBetween(earlier: Date, later: Date): number {
  return Math.floor(msBetween(earlier, later) / (24 * 60 * 60_000));
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const currentIndex = index;
      index += 1;
      const item = items[currentIndex];
      if (!item) return;
      results[currentIndex] = await mapper(item);
    }
  });

  await Promise.all(workers);
  return results;
}

async function anyOrgMemberInLogins(org: string, logins: readonly string[]): Promise<boolean> {
  for (const login of logins) {
    if (await isOrgMember(org, login)) return true;
  }
  return false;
}

async function listIssueCommentAuthorLoginsForPullRequest(options: {
  repo: RepoRef;
  prNumber: number;
  page: number;
  perPage: number;
}): Promise<string[]> {
  const url = new URL(
    `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/issues/${options.prNumber}/comments`
  );
  url.searchParams.set('per_page', String(options.perPage));
  url.searchParams.set('page', String(options.page));

  const response = await githubRequest(url.toString(), { method: 'GET' });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `GitHub list issue comments failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
    );
  }

  const json = ISSUE_COMMENTS_RESPONSE_SCHEMA.parse(await response.json());
  const logins: string[] = [];
  for (const comment of json) {
    const login = comment.user?.login;
    if (login) logins.push(login);
  }
  return logins;
}

async function listReviewCommentAuthorLoginsForPullRequest(options: {
  repo: RepoRef;
  prNumber: number;
  page: number;
  perPage: number;
}): Promise<string[]> {
  const url = new URL(
    `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/pulls/${options.prNumber}/comments`
  );
  url.searchParams.set('per_page', String(options.perPage));
  url.searchParams.set('page', String(options.page));

  const response = await githubRequest(url.toString(), { method: 'GET' });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `GitHub list review comments failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
    );
  }

  const json = REVIEW_COMMENTS_RESPONSE_SCHEMA.parse(await response.json());
  const logins: string[] = [];
  for (const comment of json) {
    const login = comment.user?.login;
    if (login) logins.push(login);
  }
  return logins;
}

async function listPullRequestReviewApproverLoginsForPullRequest(options: {
  repo: RepoRef;
  prNumber: number;
  page: number;
  perPage: number;
}): Promise<{ reviews: Array<{ state: string; userLogin: string }>; totalReviews: number }> {
  const url = new URL(
    `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/pulls/${options.prNumber}/reviews`
  );
  url.searchParams.set('per_page', String(options.perPage));
  url.searchParams.set('page', String(options.page));

  const response = await githubRequest(url.toString(), { method: 'GET' });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `GitHub list pull request reviews failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
    );
  }

  const json = PULL_REQUEST_REVIEWS_RESPONSE_SCHEMA.parse(await response.json());
  const reviews: Array<{ state: string; userLogin: string }> = [];

  for (const review of json) {
    if (
      review.state !== 'APPROVED' &&
      review.state !== 'CHANGES_REQUESTED' &&
      review.state !== 'COMMENTED'
    ) {
      continue;
    }
    const userLogin = review.user?.login;
    if (userLogin) {
      reviews.push({ state: review.state, userLogin });
    }
  }

  return { reviews, totalReviews: json.length };
}

async function getPullRequestReviewStatusAndTeamReviewed(options: {
  repo: RepoRef;
  org: string;
  prNumber: number;
  maxPullRequestReviewPages: number;
}): Promise<{ reviewStatus: PullRequestReviewStatus; teamReviewed: boolean }> {
  const perPage = 100;

  const latestStateByLowerLogin = new Map<string, string>();

  for (let page = 1; page <= options.maxPullRequestReviewPages; page += 1) {
    const { reviews, totalReviews } = await listPullRequestReviewApproverLoginsForPullRequest({
      repo: options.repo,
      prNumber: options.prNumber,
      page,
      perPage,
    });

    for (const review of reviews) {
      latestStateByLowerLogin.set(review.userLogin.toLowerCase(), review.state);
    }

    if (totalReviews < perPage) break;
  }

  if (latestStateByLowerLogin.size === 0) {
    return { reviewStatus: 'no_reviews', teamReviewed: false };
  }

  const latestStates = [...latestStateByLowerLogin.values()];
  const allLogins = [...latestStateByLowerLogin.keys()];

  const teamReviewed = await anyOrgMemberInLogins(options.org, allLogins);

  if (latestStates.includes('CHANGES_REQUESTED')) {
    return { reviewStatus: 'changes_requested', teamReviewed };
  }

  const approvedLogins = [...latestStateByLowerLogin.entries()]
    .filter(([, state]) => state === 'APPROVED')
    .map(([lowerLogin]) => lowerLogin);

  if (approvedLogins.length > 0) {
    if (await anyOrgMemberInLogins(options.org, approvedLogins)) {
      return { reviewStatus: 'approved', teamReviewed };
    }
  }

  if (latestStates.includes('COMMENTED')) {
    return { reviewStatus: 'commented', teamReviewed };
  }

  return { reviewStatus: 'no_reviews', teamReviewed };
}

async function hasOrgMemberCommentedOnPullRequest(options: {
  repo: RepoRef;
  repoId: string;
  org: string;
  prNumber: number;
  maxIssueCommentPages: number;
  maxReviewCommentPages: number;
  maxPullRequestReviewPages: number;
}): Promise<PullRequestTeamInteraction> {
  const cacheKey = `${options.repoId}:${options.prNumber}`;
  const now = Date.now();
  const cached = teamCommentedCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) {
    return cached.value;
  }

  const perPage = 100;

  for (let page = 1; page <= options.maxIssueCommentPages; page += 1) {
    const logins = await listIssueCommentAuthorLoginsForPullRequest({
      repo: options.repo,
      prNumber: options.prNumber,
      page,
      perPage,
    });
    if (await anyOrgMemberInLogins(options.org, logins)) {
      const { reviewStatus } = await getPullRequestReviewStatusAndTeamReviewed({
        repo: options.repo,
        org: options.org,
        prNumber: options.prNumber,
        maxPullRequestReviewPages: options.maxPullRequestReviewPages,
      });
      const value: PullRequestTeamInteraction = { teamCommented: true, reviewStatus };
      teamCommentedCache.set(cacheKey, { value, expiresAtMs: now + TEAM_COMMENTED_TTL_MS });
      return value;
    }
    if (logins.length < perPage) break;
  }

  const { reviewStatus, teamReviewed } = await getPullRequestReviewStatusAndTeamReviewed({
    repo: options.repo,
    org: options.org,
    prNumber: options.prNumber,
    maxPullRequestReviewPages: options.maxPullRequestReviewPages,
  });

  if (teamReviewed) {
    const value: PullRequestTeamInteraction = { teamCommented: true, reviewStatus };
    teamCommentedCache.set(cacheKey, { value, expiresAtMs: now + TEAM_COMMENTED_TTL_MS });
    return value;
  }

  for (let page = 1; page <= options.maxReviewCommentPages; page += 1) {
    const logins = await listReviewCommentAuthorLoginsForPullRequest({
      repo: options.repo,
      prNumber: options.prNumber,
      page,
      perPage,
    });
    if (await anyOrgMemberInLogins(options.org, logins)) {
      const value: PullRequestTeamInteraction = { teamCommented: true, reviewStatus };
      teamCommentedCache.set(cacheKey, { value, expiresAtMs: now + TEAM_COMMENTED_TTL_MS });
      return value;
    }
    if (logins.length < perPage) break;
  }

  const value: PullRequestTeamInteraction = { teamCommented: false, reviewStatus };
  teamCommentedCache.set(cacheKey, { value, expiresAtMs: now + TEAM_COMMENTED_TTL_MS });
  return value;
}

export async function getKilocodeRepoOpenPullRequestCounts(options?: {
  ttlMs?: number;
  includeDrafts?: boolean;
  repoId?: RepoId;
}): Promise<OpenPullRequestCounts> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const includeDrafts = options?.includeDrafts ?? false;
  const repoId = options?.repoId ?? 'kilocode';
  const repo = SUPPORTED_REPOS[repoId];
  const shouldUseCache = ttlMs > 0;
  const now = Date.now();
  const cacheKey = `${repoId}:${includeDrafts}`;

  if (shouldUseCache) {
    const cached = countsCacheByKey.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.value;
    }
  }

  const inFlight = countsInFlightByKey.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const authorsByPr = await listOpenPullRequestAuthors({ repo, includeDrafts });

    const uniqueNonBotAuthorsByLowerLogin = new Map<string, string>();
    for (const author of authorsByPr) {
      if (isBotGithubUser(author)) continue;
      const lower = author.login.toLowerCase();
      if (!uniqueNonBotAuthorsByLowerLogin.has(lower)) {
        uniqueNonBotAuthorsByLowerLogin.set(lower, author.login);
      }
    }

    const isMemberByLogin = new Map<string, boolean>();
    for (const [lowerLogin, originalLogin] of uniqueNonBotAuthorsByLowerLogin.entries()) {
      isMemberByLogin.set(lowerLogin, await isOrgMember(ORG, originalLogin));
    }

    let teamOpenPullRequests = 0;
    let externalOpenPullRequests = 0;

    for (const author of authorsByPr) {
      if (isBotGithubUser(author)) {
        teamOpenPullRequests += 1;
        continue;
      }
      const isMember = isMemberByLogin.get(author.login.toLowerCase()) ?? false;
      if (isMember) teamOpenPullRequests += 1;
      else externalOpenPullRequests += 1;
    }

    const value: OpenPullRequestCounts = {
      totalOpenPullRequests: authorsByPr.length,
      teamOpenPullRequests,
      externalOpenPullRequests,
      updatedAt: new Date().toISOString(),
    };

    if (shouldUseCache) {
      countsCacheByKey.set(cacheKey, { value, expiresAtMs: Date.now() + ttlMs });
    }
    return value;
  })();

  countsInFlightByKey.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    countsInFlightByKey.delete(cacheKey);
  }
}

async function getOpenPullRequestsSummaryForRepo(
  repoId: RepoId,
  options: {
    ttlMs: number;
    includeDrafts: boolean;
    commentConcurrency: number;
    maxIssueCommentPages: number;
    maxReviewCommentPages: number;
    maxPullRequestReviewPages: number;
  }
): Promise<OpenPullRequestsSummary> {
  const { ttlMs, includeDrafts } = options;
  const repo = SUPPORTED_REPOS[repoId];
  const shouldUseCache = ttlMs > 0;
  const now = Date.now();
  const cacheKey = `${repoId}:${includeDrafts}`;

  if (shouldUseCache) {
    const cached = summaryCacheByKey.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.value;
    }
  }

  const inFlight = summaryInFlightByKey.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const prs = await listOpenPullRequests({ repo, includeDrafts });

    const prsWithAuthors = prs.flatMap(pr => {
      const user = pr.user;
      if (!user) return [];
      return [{ pr, author: toGithubUserLite(user) }];
    });

    const orgMembers = await fetchOrgMembers(ORG);

    let teamOpenPullRequests = 0;
    let externalOpenPullRequests = 0;

    const external: Array<{ pr: OpenPullRequestApiSummary; authorLogin: string }> = [];
    for (const { pr, author } of prsWithAuthors) {
      if (isBotGithubUser(author)) {
        teamOpenPullRequests += 1;
        continue;
      }
      if (orgMembers.has(author.login.toLowerCase())) {
        teamOpenPullRequests += 1;
      } else {
        externalOpenPullRequests += 1;
        external.push({ pr, authorLogin: author.login });
      }
    }

    const nowDate = new Date();
    const externalListBase: ExternalOpenPullRequest[] = external.map(({ pr, authorLogin }) => {
      const createdAt = pr.created_at;
      const createdAtDate = new Date(createdAt);
      const ageDays = Number.isNaN(createdAtDate.getTime())
        ? 0
        : daysBetween(createdAtDate, nowDate);

      const commentCount = pr.comments + pr.review_comments;

      return {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        repo: repoId,
        authorLogin,
        createdAt,
        ageDays,
        commentCount,
        teamCommented: false,
        reviewStatus: 'no_reviews',
      };
    });

    const teamInteractionResults = await mapWithConcurrencyLimit<
      ExternalOpenPullRequest,
      PullRequestTeamInteraction
    >(externalListBase, options.commentConcurrency, async pr => {
      return hasOrgMemberCommentedOnPullRequest({
        repo,
        repoId,
        org: ORG,
        prNumber: pr.number,
        maxIssueCommentPages: options.maxIssueCommentPages,
        maxReviewCommentPages: options.maxReviewCommentPages,
        maxPullRequestReviewPages: options.maxPullRequestReviewPages,
      });
    });

    const externalOpenPullRequestsList: ExternalOpenPullRequest[] = externalListBase.map(
      (pr, idx) => {
        const interaction = teamInteractionResults[idx];
        if (!interaction) {
          return { ...pr, teamCommented: false, reviewStatus: 'no_reviews' as const };
        }
        return {
          ...pr,
          teamCommented: interaction.teamCommented,
          reviewStatus: interaction.reviewStatus,
        };
      }
    );

    const value: OpenPullRequestsSummary = {
      totalOpenPullRequests: prsWithAuthors.length,
      teamOpenPullRequests,
      externalOpenPullRequests,
      externalOpenPullRequestsList,
      updatedAt: new Date().toISOString(),
    };

    if (shouldUseCache) {
      summaryCacheByKey.set(cacheKey, { value, expiresAtMs: Date.now() + ttlMs });
    }
    return value;
  })();

  summaryInFlightByKey.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    summaryInFlightByKey.delete(cacheKey);
  }
}

export async function getKilocodeRepoOpenPullRequestsSummary(options?: {
  ttlMs?: number;
  includeDrafts?: boolean;
  repos?: RepoId[];
  commentConcurrency?: number;
  maxIssueCommentPages?: number;
  maxReviewCommentPages?: number;
  maxPullRequestReviewPages?: number;
}): Promise<OpenPullRequestsSummary> {
  const repos = [...new Set(options?.repos ?? ALL_REPO_IDS)];
  const resolvedOptions = {
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    includeDrafts: options?.includeDrafts ?? false,
    commentConcurrency: options?.commentConcurrency ?? 4,
    maxIssueCommentPages: options?.maxIssueCommentPages ?? 2,
    maxReviewCommentPages: options?.maxReviewCommentPages ?? 1,
    maxPullRequestReviewPages: options?.maxPullRequestReviewPages ?? 1,
  };

  // Fetch all repos in parallel
  const perRepoSummaries = await Promise.all(
    repos.map(repoId => getOpenPullRequestsSummaryForRepo(repoId, resolvedOptions))
  );

  // Merge results
  let totalOpenPullRequests = 0;
  let teamOpenPullRequests = 0;
  let externalOpenPullRequests = 0;
  const externalOpenPullRequestsList: ExternalOpenPullRequest[] = [];

  for (const summary of perRepoSummaries) {
    totalOpenPullRequests += summary.totalOpenPullRequests;
    teamOpenPullRequests += summary.teamOpenPullRequests;
    externalOpenPullRequests += summary.externalOpenPullRequests;
    externalOpenPullRequestsList.push(...summary.externalOpenPullRequestsList);
  }

  return {
    totalOpenPullRequests,
    teamOpenPullRequests,
    externalOpenPullRequests,
    externalOpenPullRequestsList,
    updatedAt: new Date().toISOString(),
  };
}

const mergedPrsCache = new Map<string, CacheEntry<ExternalMergedPullRequest[]>>();
const mergedPrsInFlight = new Map<string, Promise<ExternalMergedPullRequest[]>>();

const closedPrsCache = new Map<string, CacheEntry<ExternalClosedPullRequestsWithWeekStats>>();
const closedPrsInFlight = new Map<string, Promise<ExternalClosedPullRequestsWithWeekStats>>();

async function listMergedPullRequests(options: {
  repo: RepoRef;
  maxResults: number;
}): Promise<z.infer<typeof CLOSED_PULL_REQUEST_ITEM_SCHEMA>[]> {
  const perPage = 100;
  const prs: z.infer<typeof CLOSED_PULL_REQUEST_ITEM_SCHEMA>[] = [];
  const maxPages = Math.ceil(options.maxResults / perPage);

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/pulls`
    );
    url.searchParams.set('state', 'closed');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url.toString());
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `GitHub list pulls failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
      );
    }

    const json = CLOSED_PULL_REQUESTS_RESPONSE_SCHEMA.parse(await response.json());

    // Filter to only merged PRs
    const mergedInBatch = json.filter(pr => pr.merged_at !== null);
    prs.push(...mergedInBatch);

    // Stop if we have enough merged PRs
    if (prs.length >= options.maxResults) {
      return prs.slice(0, options.maxResults);
    }

    // Stop if we got fewer results than requested (last page)
    if (json.length < perPage) {
      return prs;
    }
  }

  return prs;
}

export async function getKilocodeRepoRecentlyMergedExternalPRs(options?: {
  ttlMs?: number;
  maxResults?: number;
  repoId?: RepoId;
}): Promise<ExternalMergedPullRequest[]> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxResults = options?.maxResults ?? 50;
  const repoId = options?.repoId ?? 'kilocode';
  const repo = SUPPORTED_REPOS[repoId];
  const shouldUseCache = ttlMs > 0;
  const now = Date.now();
  const cacheKey = `${repoId}:${maxResults}`;

  if (shouldUseCache) {
    const cached = mergedPrsCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.value;
    }
  }

  const inFlight = mergedPrsInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const prs = await listMergedPullRequests({ repo, maxResults });

    const prsWithAuthors = prs.flatMap(pr => {
      const user = pr.user;
      if (!user || !pr.merged_at) return [];
      return [{ pr, author: toGithubUserLite(user), mergedAt: pr.merged_at }];
    });

    const orgMembers = await fetchOrgMembers(ORG);

    const external: ExternalMergedPullRequest[] = [];
    for (const { pr, author, mergedAt } of prsWithAuthors) {
      if (isBotGithubUser(author)) continue;

      if (!orgMembers.has(author.login.toLowerCase())) {
        external.push({
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          authorLogin: author.login,
          mergedAt,
        });
      }
    }

    external.sort((a, b) => {
      const dateA = new Date(a.mergedAt).getTime();
      const dateB = new Date(b.mergedAt).getTime();
      return dateB - dateA;
    });

    if (shouldUseCache) {
      mergedPrsCache.set(cacheKey, { value: external, expiresAtMs: Date.now() + ttlMs });
    }
    return external;
  })();

  mergedPrsInFlight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    mergedPrsInFlight.delete(cacheKey);
  }
}

async function listRecentlyClosedPullRequests(options: {
  repo: RepoRef;
  maxResults: number;
}): Promise<z.infer<typeof CLOSED_PULL_REQUEST_ITEM_SCHEMA>[]> {
  const perPage = 100;
  const prs: z.infer<typeof CLOSED_PULL_REQUEST_ITEM_SCHEMA>[] = [];

  // We may need more than maxResults items to find `maxResults` external PRs.
  const maxPages = Math.ceil((options.maxResults * 4) / perPage);

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${options.repo.owner}/${options.repo.name}/pulls`
    );
    url.searchParams.set('state', 'closed');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url.toString());
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `GitHub list pulls failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
      );
    }

    const json = CLOSED_PULL_REQUESTS_RESPONSE_SCHEMA.parse(await response.json());
    prs.push(...json);

    if (json.length < perPage) return prs;
  }

  return prs;
}

async function getRecentlyClosedExternalPRsForRepo(
  repoId: RepoId,
  options: {
    ttlMs: number;
    maxResults: number;
    weekBounds: IsoWeekBounds;
  }
): Promise<ExternalClosedPullRequestsWithWeekStats> {
  const { ttlMs, maxResults, weekBounds } = options;
  const repo = SUPPORTED_REPOS[repoId];
  const shouldUseCache = ttlMs > 0;
  const now = Date.now();
  const cacheKey = `${repoId}:${maxResults}`;

  if (shouldUseCache) {
    const cached = closedPrsCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.value;
    }
  }

  const inFlight = closedPrsInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const prs = await listRecentlyClosedPullRequests({ repo, maxResults });

    const prsWithAuthors = prs.flatMap(pr => {
      const user = pr.user;
      const closedAt = pr.closed_at;
      if (!user || !closedAt) return [];
      return [{ pr, author: toGithubUserLite(user), closedAt }];
    });

    const orgMembers = await fetchOrgMembers(ORG);

    const external: ExternalClosedPullRequest[] = [];
    for (const { pr, author, closedAt } of prsWithAuthors) {
      if (isBotGithubUser(author)) continue;

      if (orgMembers.has(author.login.toLowerCase())) continue;

      const mergedAt = pr.merged_at;
      const status: ExternalClosedPullRequestStatus = mergedAt ? 'merged' : 'closed';
      const displayDate = mergedAt ?? closedAt;

      external.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        repo: repoId,
        authorLogin: author.login,
        closedAt,
        mergedAt,
        status,
        displayDate,
      });
    }

    external.sort((a, b) => {
      const dateA = new Date(a.displayDate).getTime();
      const dateB = new Date(b.displayDate).getTime();
      return dateB - dateA;
    });

    const trimmed = external.slice(0, maxResults);

    const thisWeekMergedCount = trimmed.filter(pr => {
      if (pr.status !== 'merged') return false;
      const mergedAt = pr.mergedAt;
      if (!mergedAt) return false;
      return isIsoTimestampWithinBounds(mergedAt, weekBounds);
    }).length;

    const thisWeekClosedCount = trimmed.filter(pr => {
      if (pr.status !== 'closed') return false;
      return isIsoTimestampWithinBounds(pr.closedAt, weekBounds);
    }).length;

    const value: ExternalClosedPullRequestsWithWeekStats = {
      prs: trimmed,
      thisWeekMergedCount,
      thisWeekClosedCount,
      weekStart: weekBounds.weekStart.toISOString(),
      weekEnd: weekBounds.weekEnd.toISOString(),
    };

    if (shouldUseCache) {
      closedPrsCache.set(cacheKey, { value, expiresAtMs: Date.now() + ttlMs });
    }

    return value;
  })();

  closedPrsInFlight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    closedPrsInFlight.delete(cacheKey);
  }
}

export async function getKilocodeRepoRecentlyClosedExternalPRs(options?: {
  ttlMs?: number;
  maxResults?: number;
  repos?: RepoId[];
  now?: Date;
  timeZone?: string;
}): Promise<ExternalClosedPullRequestsWithWeekStats> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxResults = options?.maxResults ?? 50;
  const repos = [...new Set(options?.repos ?? ALL_REPO_IDS)];
  const nowDate = options?.now ?? new Date();
  const timeZone = options?.timeZone ?? 'Europe/Amsterdam';
  const weekBounds = getCurrentIsoWeekBoundsInTimeZone({ now: nowDate, timeZone });

  // Fetch all repos in parallel
  const perRepoResults = await Promise.all(
    repos.map(repoId =>
      getRecentlyClosedExternalPRsForRepo(repoId, { ttlMs, maxResults, weekBounds })
    )
  );

  // Merge results
  const allPrs: ExternalClosedPullRequest[] = [];
  let thisWeekMergedCount = 0;
  let thisWeekClosedCount = 0;

  for (const result of perRepoResults) {
    allPrs.push(...result.prs);
    thisWeekMergedCount += result.thisWeekMergedCount;
    thisWeekClosedCount += result.thisWeekClosedCount;
  }

  // Re-sort merged results by displayDate descending, then trim
  allPrs.sort((a, b) => {
    const dateA = new Date(a.displayDate).getTime();
    const dateB = new Date(b.displayDate).getTime();
    return dateB - dateA;
  });

  const trimmed = allPrs.slice(0, maxResults);

  return {
    prs: trimmed,
    thisWeekMergedCount,
    thisWeekClosedCount,
    weekStart: weekBounds.weekStart.toISOString(),
    weekEnd: weekBounds.weekEnd.toISOString(),
  };
}
