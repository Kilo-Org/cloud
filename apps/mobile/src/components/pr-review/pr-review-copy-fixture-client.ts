import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { createTRPCClient, httpLink } from '@trpc/client';
import { z } from 'zod';

import { reviewOverviewFixture } from '@/components/pr-review/pr-review-overview-copy-fixture';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

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
  | RouterOutputs['user']['getMe'];

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
            throw new Error('Review copy fixture does not allow writes');
          }
          if (url.includes('/githubPrReview.getPullRequest')) {
            return fixtureResponse(reviewOverviewFixture);
          }
          if (url.includes('/githubPrReview.listChecks')) {
            return surface === 'checks-not-available'
              ? readFailure('githubPrReview.listChecks')
              : fixtureResponse(checks);
          }
          if (url.includes('/githubPrReview.listFiles')) {
            const pageInput = FilePageInput.parse(
              JSON.parse(new URL(url, FIXTURE_URL_BASE).searchParams.get('input') ?? '{}')
            );
            const offset = pageInput.cursor === 100 ? 100 : 0;
            return fixtureResponse({
              files: files.slice(offset, offset + 100),
              nextCursor: offset === 0 ? 100 : null,
            } satisfies RouterOutputs['githubPrReview']['listFiles']);
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
