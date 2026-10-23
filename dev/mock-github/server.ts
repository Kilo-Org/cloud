/**
 * Local mock GitHub API for the PR-review surfaces.
 *
 * The web app's PR-review client honors `GITHUB_API_BASE_URL`, so pointing it
 * at this server lets the merge and overview screens render with fixture data
 * and a seeded dev user token, without a provider connection. The server
 * answers only the REST and GraphQL requests those screens make.
 *
 * Usage: `pnpm dev:mock-github`, then set `GITHUB_API_BASE_URL` to the URL it
 * prints and restart the web app and the git-token service.
 *
 * `MOCK_GITHUB_MERGE_MODE=success` makes the merge call report a completed
 * merge; the branch-delete request still 404s, which exercises the partial
 * success banner. The default reports an unmerged result.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  conversationGraphQlFixture,
  FIXTURE_OWNER,
  FIXTURE_REPO,
  overviewGraphQlFixture,
  pullRequestFixture,
  repoFixture,
  reviewThreadsGraphQlFixture,
} from './fixtures';

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 4790);
const HOST = '127.0.0.1';
const MERGE_MODE = process.env.MOCK_GITHUB_MERGE_MODE === 'success' ? 'success' : 'unmerged';

const REPO_PATH = `/repos/${FIXTURE_OWNER}/${FIXTURE_REPO}`;

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  request.on('data', chunk => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });
  request.on('end', () => {
    resolve(Buffer.concat(chunks).toString('utf8'));
  });
  return promise;
}

function isQueryBody(value: unknown): value is { query: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'query' in value &&
    typeof value.query === 'string'
  );
}

function graphQlAnswer(query: string): unknown {
  if (query.includes('reviewThreads')) {
    return reviewThreadsGraphQlFixture();
  }
  if (query.includes('latestReviews')) {
    return overviewGraphQlFixture();
  }
  if (query.includes('comments(')) {
    return conversationGraphQlFixture();
  }
  return { data: {} };
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'POST' && path === '/graphql') {
      const body = await readBody(request);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      send(response, 200, graphQlAnswer(isQueryBody(parsed) ? parsed.query : ''));
      return;
    }

    if (path === '/user') {
      send(response, 200, {
        login: 'octocat',
        id: 583231,
        avatar_url: 'https://avatars.example.com/u/1',
      });
      return;
    }
    if (path === REPO_PATH) {
      send(response, 200, repoFixture());
      return;
    }

    const pullMatch = new RegExp(`^${REPO_PATH}/pulls/(\\d+)$`).exec(path);
    if (pullMatch) {
      const pull = pullRequestFixture(Number(pullMatch[1]));
      if (!pull) {
        send(response, 404, { message: 'Not Found' });
        return;
      }
      send(response, 200, pull);
      return;
    }

    if (new RegExp(`^${REPO_PATH}/pulls/(\\d+)/files$`).test(path)) {
      send(response, 200, []);
      return;
    }

    if (method === 'PUT' && new RegExp(`^${REPO_PATH}/pulls/(\\d+)/merge$`).test(path)) {
      send(
        response,
        200,
        MERGE_MODE === 'success'
          ? { merged: true, sha: 'c'.repeat(40), message: 'Pull Request successfully merged' }
          : { merged: false, sha: null, message: 'Pull Request is not mergeable' }
      );
      return;
    }

    if (new RegExp(`^${REPO_PATH}/commits/[^/]+/check-runs$`).test(path)) {
      send(response, 200, { total_count: 0, check_runs: [] });
      return;
    }
    if (new RegExp(`^${REPO_PATH}/commits/[^/]+/statuses$`).test(path)) {
      send(response, 200, []);
      return;
    }
    if (path.startsWith('/search/issues')) {
      send(response, 200, { total_count: 0, items: [] });
      return;
    }

    send(response, 404, { message: 'Not Found', path });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`mock GitHub listening on http://${HOST}:${PORT} (merge mode: ${MERGE_MODE})`);
});
