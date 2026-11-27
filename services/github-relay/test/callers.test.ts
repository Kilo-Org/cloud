import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The migration proxy's own GitHub client, so the allow-list is checked against the calls it makes.
import { createGithubClient } from '../../migration-proxy/src/github';
import { CALLERS, matchTarget } from '../src/callers';

const RELAY = 'https://github-relay.kiloapps.io';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const repo = '/migration-proxy/repos/Kilo-Org/cloud';

/** GitHub's answer shapes, enough for the client to accept them. */
function answerFor(url: URL): unknown {
  const path = url.pathname;
  if (path.includes('/compare/')) return { status: 'ahead' };
  if (path.includes('/git/trees/')) return { truncated: false, tree: [] };
  if (path.includes('/git/blobs/')) return { encoding: 'base64', content: '' };
  if (path.endsWith('/pulls')) return [];
  if (path.endsWith('/reviews')) return [];
  if (path.includes('/contents/')) return { type: 'file', sha: OTHER };
  return [{ sha: OTHER }];
}

describe('the migration proxy allow-list', () => {
  it('admits every read the proxy client makes through the relay, and nothing goes to the relay unrouted', async () => {
    const pem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const relayed: string[] = [];
    const direct: string[] = [];
    const client = createGithubClient(
      {
        appId: '5952011',
        installationId: '186479258',
        apiUrl: 'https://api.github.com',
        privateKey: async () => pem,
        relay: { url: `${RELAY}/migration-proxy`, token: async () => 'sts' },
      },
      async (url, init) => {
        if (url.startsWith(RELAY)) {
          relayed.push(url);
          expect(init.method ?? 'GET').toBe('GET');
          return Response.json(answerFor(new URL(url)));
        }
        direct.push(`${init.method ?? 'GET'} ${url}`);
        return Response.json(
          { token: 'ghs', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 }
        );
      }
    );
    await client.compare(SHA, OTHER);
    await client.compare(SHA, 'main');
    await client.tree(SHA);
    await client.blob(SHA);
    await client.lastCommitTouching(SHA, 'packages/db/src/migrations/0387_add_index.sql');
    await client.pullsOfCommit(SHA);
    await client.reviews(13020);
    await client.blobAt(SHA, 'packages/db/src/migrations/meta/_journal.json');

    expect(direct).toEqual(['POST https://api.github.com/app/installations/186479258/access_tokens']);
    expect(relayed.map(url => {
      const result = matchTarget(new URL(url));
      return result.ok ? result.route.name : result.reason;
    })).toEqual(['compare', 'compare', 'tree', 'blob', 'commits', 'commit-pulls', 'reviews', 'contents']);
  });

  it.each([
    ['another repository', `/migration-proxy/repos/Kilo-Org/kilocode/git/trees/${SHA}`, 'path_not_allowed'],
    ['the installation repository list', '/migration-proxy/installation/repositories', 'path_not_allowed'],
    ['the token mint', '/migration-proxy/app/installations/186479258/access_tokens', 'path_not_allowed'],
    ['a dot segment out of the repository', `${repo}/git/trees/../../../../user`, 'path_not_allowed'],
    ['an encoded dot segment', `${repo}/contents/packages/db/src/migrations/%2e%2e/%2e%2e/x`, 'path_not_allowed'],
    ['an encoded slash', `${repo}/contents/packages/db/src/migrations/a%2Fb`, 'path_not_allowed'],
    ['contents outside the migrations', `${repo}/contents/.github/CODEOWNERS?ref=${SHA}`, 'path_not_allowed'],
    ['a branch name in a tree', `${repo}/git/trees/main`, 'path_not_allowed'],
    ['a compare base that is a branch', `${repo}/compare/main...${SHA}`, 'path_not_allowed'],
    ['a trailing slash', `${repo}/git/trees/${SHA}/`, 'path_not_allowed'],
    ['an unknown query key', `${repo}/git/trees/${SHA}?recursive=1`, 'query_not_allowed'],
    ['a repeated query key', `${repo}/compare/${SHA}...${SHA}?per_page=1&per_page=2`, 'query_not_allowed'],
    ['a commits path outside the migrations', `${repo}/commits?sha=${SHA}&path=.github/CODEOWNERS`, 'query_not_allowed'],
    ['a contents ref that is a branch', `${repo}/contents/packages/db/src/migrations/x.sql?ref=main`, 'query_not_allowed'],
    ['another caller prefix', `/migration-proxyx/repos/Kilo-Org/cloud/git/trees/${SHA}`, 'unknown_caller'],
    ['no caller prefix', `/repos/Kilo-Org/cloud/git/trees/${SHA}`, 'unknown_caller'],
  ])('refuses %s', (_label, target, reason) => {
    expect(matchTarget(new URL(target, RELAY))).toEqual({ ok: false, reason });
  });

  it('forwards the checked path and query exactly, without the caller prefix', () => {
    const result = matchTarget(
      new URL(`${repo}/commits?sha=${SHA}&path=packages%2Fdb%2Fsrc%2Fmigrations%2Fx.sql&per_page=1`, RELAY)
    );
    expect(result).toMatchObject({
      ok: true,
      route: { name: 'commits' },
      upstreamPath: `/repos/Kilo-Org/cloud/commits?sha=${SHA}&path=packages%2Fdb%2Fsrc%2Fmigrations%2Fx.sql&per_page=1`,
    });
  });

  it('enables the migration proxy alone', () => {
    expect(CALLERS.map(caller => [caller.prefix, caller.scope, caller.workload])).toEqual([
      ['/migration-proxy', 'github-relay:migration-proxy.read', 'migration-proxy'],
    ]);
  });
});
