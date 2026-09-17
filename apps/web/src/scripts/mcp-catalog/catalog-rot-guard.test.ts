/**
 * Rot-guard tests for the mutation allowlist in `buildCatalogRows` (catalog.ts).
 *
 * The guard exists so an allowlisted mutation never disappears from the catalog
 * without a word. It must compare the allowlist against the paths the catalog
 * publishes with kind "mutation" — those that survive the top-level denylist,
 * and only if their procedure is still a mutation. A denylisted entry, or one
 * demoted to a query, would otherwise pass the guard and be dropped silently.
 * The real allowlist holds no such path, so this file mocks the mutations
 * module with one; `catalog.test.ts` exercises the same function against the
 * real allowlist.
 */
jest.mock('./mutations', () => {
  const MCP_MUTATION_ALLOWLIST = ['admin.sessions.delete', 'agentProfiles.create'];
  return {
    MCP_MUTATION_ALLOWLIST,
    isAllowedMutation: (path: string) => MCP_MUTATION_ALLOWLIST.includes(path),
  };
});

import { buildCatalogRows, type CatalogLeaf } from './catalog';

const queryLeaf = (path: string): CatalogLeaf => ({ path, type: 'query', firstInput: undefined });
const mutationLeaf = (path: string): CatalogLeaf => ({
  path,
  type: 'mutation',
  firstInput: undefined,
});

describe('buildCatalogRows rot guard', () => {
  it('fails when an allowlisted mutation is withheld by the top-level denylist', () => {
    // The path is a mutation leaf, so a pre-denylist guard would accept it —
    // but the catalog drops it, so the dump must fail loudly instead.
    expect(() =>
      buildCatalogRows([mutationLeaf('admin.sessions.delete'), queryLeaf('user.getProfile')])
    ).toThrow(/admin\.sessions\.delete/);
  });

  it('still fails when an allowlisted mutation matches no mutation leaf', () => {
    expect(() =>
      buildCatalogRows([mutationLeaf('agentProfiles.createRenamed'), queryLeaf('user.getProfile')])
    ).toThrow(/agentProfiles\.create/);
  });

  it('fails when an allowlisted path ships as a query instead of a mutation', () => {
    // A procedure demoted to a query publishes fine, so comparing the allowlist
    // against every published path would let it pass silently. Only the paths
    // published with kind "mutation" may satisfy the guard.
    expect(() =>
      buildCatalogRows([queryLeaf('agentProfiles.create'), mutationLeaf('user.updateProfile')])
    ).toThrow(/agentProfiles\.create/);
  });

  it('fails when a query-only enumeration leaves every allowlisted mutation unpublished', () => {
    // Wholesale router drift — every mutation leaf gone — must not publish a
    // query-only catalog in silence: the allowlist is compared even when the
    // enumeration carried no mutation leaf at all.
    expect(() =>
      buildCatalogRows(
        [queryLeaf('user.getProfile')],
        new Map([['user.getProfile', 'Returns the profile of a user.']])
      )
    ).toThrow(/agentProfiles\.create/);
  });
});
