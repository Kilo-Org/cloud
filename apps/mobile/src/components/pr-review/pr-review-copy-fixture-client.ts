import {
  GITLAB_REVIEW_CAPABILITIES,
  type ProviderPrMergeState,
  type ProviderPrSummary,
  type ProviderReviewCapabilities,
} from '@kilocode/app-shared/provider-review';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { createTRPCClient, httpLink } from '@trpc/client';
import { z } from 'zod';

import { reviewOverviewFixture } from '@/components/pr-review/pr-review-overview-copy-fixture';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { FIXTURE_WRITE_REFUSED } from '@/lib/pr-review/pr-review-copy-fixture-route';

// The fake reads behind the PR-review copy fixture. Real review consumers run
// against these owned DTOs across an asynchronous tRPC boundary: the reads
// never touch global fetch, and a write is refused before any mutation function
// runs. The navigator starts with 100 of 101 files, exercising listed-file
// progress; searching fetches the final page through the usual pagination hook.

export const triple = { owner: 'sample', repo: 'review-copy', number: 1 };
export const headSha = '0123456789abcdef0123456789abcdef01234567';

const files = [
  {
    path: 'src/greeting.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch:
      '@@ -1,3 +1,3 @@\n import { formatGreeting } from "./format";\n-export const greeting = "Hi";\n+export const greeting = "Hello";\n export default greeting;',
    patchMissing: false,
  },
  {
    path: 'src/greeting.test.ts',
    previousPath: null,
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+expect(greeting).toBe("Hello");',
    patchMissing: false,
  },
  ...Array.from({ length: 99 }, (_, index) => ({
    path: `src/example-${String(index + 1).padStart(3, '0')}.ts`,
    previousPath: null,
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+export const example = true;',
    patchMissing: false,
  })),
] satisfies PrReviewFile[];

/**
 * The `files-context` surface reads hunks that start below the file's first
 * line, so their expand rows carry a known gap shorter than the default window:
 * five lines on the first file and one line on the second. Every other surface
 * keeps its leading hunk at line 1.
 */
const CONTEXT_SURFACE = 'files-context';
const contextFiles = [
  {
    path: 'src/greeting.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch:
      '@@ -6,3 +6,3 @@\n export const greeting = "Hello";\n-export const name = "Hi";\n+export const name = "Hello";\n export default greeting;',
    patchMissing: false,
  },
  {
    path: 'src/greeting.test.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch:
      '@@ -2,2 +2,2 @@\n-const title = "greeting";\n+const title = "greeting test";\n export default title;',
    patchMissing: false,
  },
] satisfies PrReviewFile[];

/** The files a surface reads: the short-gap set, or the paginated full list. */
export function filesForSurface(surface: string | undefined): readonly PrReviewFile[] {
  return surface === CONTEXT_SURFACE ? contextFiles : files;
}

const checks = {
  checkRuns: [
    {
      name: 'Formatting',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      appName: null,
    },
    {
      name: 'Unit tests',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: null,
      appName: null,
    },
  ],
  rollup: { total: 2, success: 1, failure: 1, pending: 0, skipped: 0 },
} satisfies inferRouterOutputs<MobileRouter>['githubPrReview']['listChecks'];

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type FixtureReadData =
  | RouterOutputs['githubPrReview']['getPullRequest']
  | RouterOutputs['githubPrReview']['listChecks']
  | RouterOutputs['githubPrReview']['listFiles']
  | RouterOutputs['user']['getMe']
  | ProviderPrSummary
  | ProviderPrMergeState
  | ProviderReviewCapabilities;

/**
 * The GitLab merge request the provider route shape reads. The screens
 * normalize it through the seam exactly as a real `providerReview` answer is
 * normalized, so the provider arm renders the same read models as GitHub.
 */
const providerSummary: ProviderPrSummary = {
  ref: { platform: 'gitlab', projectPath: 'acme/review-copy', mrIid: 7 },
  title: 'Greet the reader in the sample project',
  body: 'Normalizes the greeting helper so every caller prints the same text.',
  author: { login: 'review-copy', avatarUrl: null },
  state: 'open',
  draft: false,
  headRef: 'greeting-copy',
  baseRef: 'main',
  headSha,
  changedFiles: 101,
  additions: 120,
  deletions: 8,
  webUrl: 'https://gitlab.example.test/acme/review-copy/-/merge_requests/7',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
};

/** The provider merge gate: open, approving nothing, nothing in the way. */
const providerMergeState: ProviderPrMergeState = {
  canMerge: true,
  approvalsRequired: 0,
  pipelineMustSucceed: false,
  conflicts: false,
  blockedReasons: [],
};

function fixtureResponse(data: FixtureReadData): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXTURE_URL = 'review-copy-fixture-trpc';
/** Absolute base for parsing the query off a relative fixture URL. */
const FIXTURE_URL_BASE = 'review-copy-fixture:/';

const FilePageInput = z.object({ cursor: z.literal(100).nullish() });

/**
 * One page of the fixture's file list: the surface's set, 100 at a time, with
 * the second page's cursor. Both route shapes read the page the same way, so a
 * provider navigator lists the same files as the GitHub one.
 */
function fixtureFilesPage(url: string, surface: string | undefined) {
  const pageInput = FilePageInput.parse(
    JSON.parse(new URL(url, FIXTURE_URL_BASE).searchParams.get('input') ?? '{}')
  );
  const offset = pageInput.cursor === 100 ? 100 : 0;
  const surfaceFiles = filesForSurface(surface);
  return {
    files: surfaceFiles.slice(offset, offset + 100),
    nextCursor: offset + 100 < surfaceFiles.length ? offset + 100 : null,
  };
}

/** A read failure in the shape the tRPC http link raises as its error. */
function readFailure(path: string): Response {
  const body = JSON.stringify({
    error: {
      message: 'No checks endpoint for this ref',
      code: -32603,
      data: { code: 'NOT_FOUND', httpStatus: 404, path, stack: '' },
    },
  });
  return new Response(body, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The fixture's tRPC client. `checks-not-available` answers the checks read as
 * not found, which is the terminal the section maps to its unavailable message;
 * every other surface answers a loaded read.
 */
export function createFixtureClient(surface: string | undefined) {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        // The fixture never reaches the network: the fetch below answers every
        // read, so this marker only names which client answered it. The base
        // lets the read below parse the query off the relative URL the link
        // builds from that marker.
        url: FIXTURE_URL,
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error(FIXTURE_WRITE_REFUSED);
          }
          if (url.includes('/githubPrReview.getPullRequest')) {
            return fixtureResponse(reviewOverviewFixture);
          }
          // The provider route shape's reads. The screens normalize these
          // through the seam, so the provider arm paints the same cards.
          if (url.includes('/providerReview.getPullRequest')) {
            return fixtureResponse(providerSummary);
          }
          if (url.includes('/providerReview.getMergeState')) {
            return fixtureResponse(providerMergeState);
          }
          if (url.includes('/providerReview.getCapabilities')) {
            return fixtureResponse(GITLAB_REVIEW_CAPABILITIES);
          }
          if (url.includes('/providerReview.listFiles')) {
            return fixtureResponse(fixtureFilesPage(url, surface));
          }
          if (url.includes('/githubPrReview.listChecks')) {
            return surface === 'checks-not-available'
              ? readFailure('githubPrReview.listChecks')
              : fixtureResponse(checks);
          }
          if (url.includes('/githubPrReview.listFiles')) {
            return fixtureResponse(fixtureFilesPage(url, surface));
          }
          if (url.includes('/user.getMe')) {
            return fixtureResponse({
              success: true,
              id: 'review-copy-fixture',
              email: 'review-copy@example.com',
              isAdmin: false,
            } satisfies RouterOutputs['user']['getMe']);
          }
          throw new Error('Read not provided by review copy fixture');
        },
      }),
    ],
  });
}

/** The file count every navigator and file-list surface advertises. */
export const fileCount = files.length;
