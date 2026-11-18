import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFixtureInsertValues,
  FIXTURE_CLOUD_AGENT_SESSION_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_PREFIX,
  fixtureCloudAgentConflictError,
  fixtureSessionDeletePredicate,
  isFixtureCloudAgentConflict,
  normalizedGitHubUrl,
  resolveFixtureRepositories,
} from './frequent-repository-order-fixture';

/** Walk nested drizzle queryChunks and collect string Param values. */
function collectBoundStringParams(condition: unknown, out: string[] = []): string[] {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      out.push(chunk);
      continue;
    }
    if (chunk == null || typeof chunk !== 'object') continue;
    const value = (chunk as { value?: unknown }).value;
    if (typeof value === 'string') {
      out.push(value);
      continue;
    }
    collectBoundStringParams(chunk, out);
  }
  return out;
}

test('fixture session id matches the session-id contract', () => {
  assert.equal(FIXTURE_SESSION_ID.length, 30);
  assert.ok(FIXTURE_SESSION_ID.startsWith('ses_'));
  assert.ok(FIXTURE_SESSION_ID.startsWith(FIXTURE_SESSION_PREFIX));
});

test('normalizedGitHubUrl normalizes case and trailing .git', () => {
  assert.equal(normalizedGitHubUrl('Acme/Widgets'), 'https://github.com/acme/widgets');
  assert.equal(normalizedGitHubUrl('acme/widgets.git'), 'https://github.com/acme/widgets');
});

test('resolveFixtureRepositories returns the first two provider-order repositories', () => {
  const { unusedRepository, usedRepository } = resolveFixtureRepositories([
    { id: 1, name: 'a', full_name: 'owner/a', private: false },
    { id: 2, name: 'b', full_name: 'owner/b', private: true },
    { id: 3, name: 'c', full_name: 'owner/c', private: false },
  ]);
  assert.equal(unusedRepository, 'owner/a');
  assert.equal(usedRepository, 'owner/b');
});

test('resolveFixtureRepositories rejects a non-array', () => {
  assert.throws(() => resolveFixtureRepositories(null), /repositories array/);
});

test('resolveFixtureRepositories rejects fewer than two numeric-id repositories', () => {
  assert.throws(
    () =>
      resolveFixtureRepositories([
        { id: 1, name: 'a', full_name: 'owner/a', private: false },
        { id: '2', name: 'b', full_name: 'owner/b', private: false },
      ]),
    /at least two/
  );
});

test('resolveFixtureRepositories rejects an empty full_name', () => {
  assert.throws(
    () =>
      resolveFixtureRepositories([
        { id: 1, name: 'a', full_name: '', private: false },
        { id: 2, name: 'b', full_name: 'owner/b', private: false },
      ]),
    /nonempty full_name/
  );
});

test('resolveFixtureRepositories rejects identical repositories', () => {
  assert.throws(
    () =>
      resolveFixtureRepositories([
        { id: 1, name: 'a', full_name: 'owner/a', private: false },
        { id: 2, name: 'a2', full_name: 'owner/a', private: false },
      ]),
    /different/
  );
});

test('buildFixtureInsertValues writes the production Cloud Agent root row shape', () => {
  const values = buildFixtureInsertValues('user-1', 'owner/b');
  assert.equal(values.session_id, FIXTURE_SESSION_ID);
  assert.equal(values.kilo_user_id, 'user-1');
  assert.equal(values.organization_id, null);
  assert.equal(values.parent_session_id, null);
  assert.equal(values.cloud_agent_session_id, FIXTURE_CLOUD_AGENT_SESSION_ID);
  assert.equal(values.cloud_agent_session_scope_id, FIXTURE_CLOUD_AGENT_SESSION_ID);
  assert.equal(values.created_on_platform, 'cloud-agent');
  assert.equal(values.git_url, 'https://github.com/owner/b');
  assert.equal(values.version, 0);
});

test('isFixtureCloudAgentConflict rejects a different Cloud Agent id', () => {
  assert.equal(isFixtureCloudAgentConflict(FIXTURE_CLOUD_AGENT_SESSION_ID), false);
  assert.equal(isFixtureCloudAgentConflict('other-cloud-agent'), true);
  assert.equal(isFixtureCloudAgentConflict(null), true);
});

test('fixtureCloudAgentConflictError names the conflicting Cloud Agent id', () => {
  const error = fixtureCloudAgentConflictError('other-cloud-agent');
  assert.match(error.message, /identity conflict/);
  assert.match(error.message, /other-cloud-agent/);
  assert.match(error.message, new RegExp(FIXTURE_SESSION_ID));
});

test('fixtureSessionDeletePredicate binds only the exact fixture session id', () => {
  const otherSessionId = 'ses_e2efreqrepo999999999999999';
  const bound = collectBoundStringParams(fixtureSessionDeletePredicate('user-1'));

  assert.ok(bound.includes(FIXTURE_SESSION_ID));
  assert.ok(bound.includes('user-1'));
  assert.ok(bound.includes(`${FIXTURE_SESSION_PREFIX}%`));
  assert.equal(bound.includes(otherSessionId), false);
});
