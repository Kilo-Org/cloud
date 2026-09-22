import assert from 'node:assert/strict';
import test from 'node:test';

import {
  W4C_ORG_PAIR_NAME_PREFIX,
  w4cOrgPairCleanupPredicate,
  w4cOrgPairName,
  w4cOrgPairOrganizationId,
} from './w4c-org-pair-fixture';

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

void test('fixture org name embeds the owner email under the stable prefix', () => {
  assert.equal(
    w4cOrgPairName('owner@example.com'),
    `${W4C_ORG_PAIR_NAME_PREFIX} owner@example.com`
  );
});

void test('cleanup predicate scopes to one owner, not the whole fixture prefix', () => {
  const owner = 'owner-a@example.com';
  const otherOwner = 'owner-b@example.com';
  const bound = collectBoundStringParams(w4cOrgPairCleanupPredicate(owner));

  assert.ok(bound.includes(w4cOrgPairName(owner)));
  assert.equal(bound.includes(w4cOrgPairName(otherOwner)), false);
  assert.equal(bound.includes(`${W4C_ORG_PAIR_NAME_PREFIX}%`), false);
});

void test('cleanup predicates for different owners never overlap', () => {
  const first = collectBoundStringParams(w4cOrgPairCleanupPredicate('first@example.com'));
  const second = collectBoundStringParams(w4cOrgPairCleanupPredicate('second@example.com'));

  assert.equal(first.includes(w4cOrgPairName('second@example.com')), false);
  assert.equal(second.includes(w4cOrgPairName('first@example.com')), false);
});

void test('fixture organization id is a stable, UUID-shaped value derived from the owner', () => {
  const id = w4cOrgPairOrganizationId('owner@example.com');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  assert.match(id, uuidPattern);
  assert.equal(id, w4cOrgPairOrganizationId('owner@example.com'));
  assert.notEqual(id, w4cOrgPairOrganizationId('other@example.com'));
});
