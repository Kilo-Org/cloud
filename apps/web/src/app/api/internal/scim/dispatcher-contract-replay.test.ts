import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  kilocode_users,
  organization_audit_logs,
  organization_membership_removals,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import {
  dispatcherCallContract,
  workOSDirectoryEvents,
  type RecordedDispatcherCall,
} from '@kilocode/scim-contracts/fixtures';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NextRequest, type NextResponse } from 'next/server';

// Stripe is not reachable in tests (`.env.test` sets a deliberately invalid
// key), so the two entry points that provision a customer are stubbed — the
// same two, for the same reason, as
// `src/lib/scim/directory-sync.integration.test.ts:24`. Everything else in this
// test is the real thing: there is deliberately no
// `jest.mock('@/lib/scim/directory-sync')` here, unlike `scim-routes.test.ts`.
jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_scim_replay'),
}));

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn().mockResolvedValue({ id: 'cus_test_scim_replay_user' }),
  deleteStripeCustomer: jest.fn().mockResolvedValue(undefined),
}));

// WorkOS is unreachable in tests, and the domain gate asks it which domains
// the organization verified through DNS. The recorded directory verified none
// — its only domain is the Okta tenant hostname, verified by hand — so an
// empty set is what the real run saw, and the user binds are refused for the
// same reason there.
jest.mock('@/lib/scim/directory-verified-domains', () => {
  // Both classes: `directory-sync` branches on
  // `instanceof VerifiedDomainOwnerMissingError`, and an omitted export is
  // `undefined` there, which throws a TypeError for every rejected lookup.
  class VerifiedDomainLookupError extends Error {}
  class VerifiedDomainOwnerMissingError extends Error {}
  return {
    VerifiedDomainLookupError,
    VerifiedDomainOwnerMissingError,
    listDnsVerifiedDomains: jest.fn().mockResolvedValue([]),
  };
});

import { PUT as putMembership, DELETE as deleteMembership } from './memberships/route';
import {
  PUT as putOrganization,
  DELETE as deleteOrganization,
} from './organizations/[directoryId]/route';
import {
  PUT as putSubOrganization,
  DELETE as deleteSubOrganization,
} from './sub-organizations/[directoryGroupId]/route';
import { DELETE as revokeAllMemberships } from './users/[externalId]/memberships/route';
import { PUT as putUser } from './users/[externalId]/route';

/**
 * Consumer half of the cross-deployment seam pin.
 *
 * Replays `packages/scim-contracts/fixtures/dispatcher-calls.json` — the exact
 * ordered HTTP calls the real `scim-sync` dispatcher emits for a recorded range
 * of the real WorkOS event stream — against these route handlers, with real
 * `authorizeInternalApiRequest`, real Zod parsing, real `@/lib/scim/directory-sync`
 * and real Postgres. The Worker's producer test
 * (`services/scim-sync/test/integration/dispatcher-contract.test.ts`) recorded
 * that file, so the two independently deployed halves are checked against one
 * artifact instead of against a fake of each other.
 *
 * What this exists to catch: a **400**. The request schemas are
 * `z.strictObject`, so a renamed or dropped field is a 400 — which the Worker
 * classifies as `unavailable` and retries indefinitely, holding its cursor
 * silently rather than failing loudly. Every assertion below therefore names
 * 400 explicitly.
 *
 * A 409 is a legitimate outcome, and the recorded range produces a specific
 * one: the directory captures the Okta tenant hostname
 * `integrator-6483000.okta.com`, while it delivers users at `gmail.com` and
 * `anaconda.com`, so every user bind is refused with `domain_not_captured`.
 * That refusal is correct behaviour and is the most valuable thing the recorded
 * range captures — it is a real-world configuration no hand-written test
 * produced. It is asserted by code, not tolerated generically.
 */

const DIRECTORY_ID = 'directory_01M6HCWBKBYRZR9KFSJWJF0CCV';
const WORKOS_ORGANIZATION_ID = 'org_01M6HCGCHX1X3JZYXAPYG2TKXJ';
const CAPTURED_DOMAIN = 'integrator-6483000.okta.com';
const DIRECTORY_USER_IDS = [
  'directory_user_01M6HD40G3RJHWSFQCHMWC7Y8D',
  'directory_user_01M6HDAV9B7FZBJFW72NAX6X42',
  'directory_user_01M6HDAXTKTVWRCFMWJ1P73SSH',
];

/**
 * The recorded path carries the WorkOS identifier in a segment, so the replay
 * has to parse it back out to build the `{ params: Promise<…> }` Next.js hands
 * a parameterised route. One table, so a new route shows up as an unmatched
 * path here rather than as a silently skipped call.
 */
const ROUTES: {
  pattern: RegExp;
  method: 'PUT' | 'DELETE';
  call: (request: NextRequest, id: string) => Promise<NextResponse>;
}[] = [
  {
    pattern: /^\/api\/internal\/scim\/organizations\/([^/]+)$/,
    method: 'PUT',
    call: (request, id) =>
      putOrganization(request, { params: Promise.resolve({ directoryId: id }) }),
  },
  {
    pattern: /^\/api\/internal\/scim\/organizations\/([^/]+)$/,
    method: 'DELETE',
    call: (request, id) =>
      deleteOrganization(request, { params: Promise.resolve({ directoryId: id }) }),
  },
  {
    pattern: /^\/api\/internal\/scim\/sub-organizations\/([^/]+)$/,
    method: 'PUT',
    call: (request, id) =>
      putSubOrganization(request, { params: Promise.resolve({ directoryGroupId: id }) }),
  },
  {
    pattern: /^\/api\/internal\/scim\/sub-organizations\/([^/]+)$/,
    method: 'DELETE',
    call: (request, id) =>
      deleteSubOrganization(request, { params: Promise.resolve({ directoryGroupId: id }) }),
  },
  {
    pattern: /^\/api\/internal\/scim\/users\/([^/]+)\/memberships$/,
    method: 'DELETE',
    call: (request, id) =>
      revokeAllMemberships(request, { params: Promise.resolve({ externalId: id }) }),
  },
  {
    pattern: /^\/api\/internal\/scim\/users\/([^/]+)$/,
    method: 'PUT',
    call: (request, id) => putUser(request, { params: Promise.resolve({ externalId: id }) }),
  },
  {
    pattern: /^\/api\/internal\/scim\/memberships$/,
    method: 'PUT',
    call: request => putMembership(request),
  },
  {
    pattern: /^\/api\/internal\/scim\/memberships$/,
    method: 'DELETE',
    call: request => deleteMembership(request),
  },
];

/** Issues one recorded call the way the Worker issues it, header and all. */
async function replay(
  call: RecordedDispatcherCall
): Promise<{ status: number; body: { code?: string; error?: string } }> {
  const route = ROUTES.find(
    candidate => candidate.method === call.method && candidate.pattern.test(call.path)
  );
  if (!route) {
    throw new Error(`No route handler matches the recorded call ${call.method} ${call.path}`);
  }
  const id = decodeURIComponent(route.pattern.exec(call.path)?.[1] ?? '');

  const request = new NextRequest(`https://kilocode.ai${call.path}`, {
    method: call.method,
    headers: {
      // The same header the Worker's `callApp` sends.
      'x-internal-api-key': INTERNAL_API_SECRET ?? '',
      ...(call.body === null ? {} : { 'content-type': 'application/json' }),
    },
    ...(call.body === null ? {} : { body: JSON.stringify(call.body) }),
  });

  const response = await route.call(request, id);
  return { status: response.status, body: (await response.json()) as { code?: string } };
}

/**
 * The recorded identifiers are the real directory's, so they are fixed rather
 * than per-run unique: the replay has to start from a database holding none of
 * them, before and after.
 */
async function removeFixtureRows(): Promise<void> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.directory_id, DIRECTORY_ID));
  const ids = rows.map(row => row.id);

  if (ids.length > 0) {
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, ids));
    await db
      .delete(organization_membership_removals)
      .where(inArray(organization_membership_removals.organization_id, ids));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, ids));
    // Children first: the self-referential foreign key is ON DELETE RESTRICT.
    await db.delete(organizations).where(inArray(organizations.parent_organization_id, ids));
    await db.delete(organizations).where(inArray(organizations.id, ids));
  }

  await db.delete(organizations).where(eq(organizations.external_org_id, WORKOS_ORGANIZATION_ID));
  await db.delete(kilocode_users).where(inArray(kilocode_users.external_id, DIRECTORY_USER_IDS));
}

beforeEach(removeFixtureRows);
afterEach(removeFixtureRows);

describe('dispatcher contract replay', () => {
  test('the real routes accept every call the dispatcher emits, and never answer 400', async () => {
    const outcomes: { call: RecordedDispatcherCall; status: number; code?: string }[] = [];

    for (const event of dispatcherCallContract.events) {
      for (const call of event.calls) {
        const response = await replay(call);
        outcomes.push({ call, status: response.status, code: response.body.code });

        // The assertion this test exists for, with the intent in the compared
        // value because Jest's `expect` takes no message: a 400 is the app's
        // `z.strictObject` refusing a body the Worker actually builds — schema
        // drift between the two deployments — and the Worker answers it by
        // holding its cursor indefinitely rather than failing loudly. A 409 is
        // a legitimate outcome, so the verdict names both.
        const verdict =
          response.status === 400
            ? `rejected the body as schema drift (400): ${JSON.stringify(response.body)}`
            : response.status === 200 || response.status === 409
              ? 'accepted (200) or conflicted on an absent dependency (409)'
              : `answered an unexpected ${response.status}: ${JSON.stringify(response.body)}`;
        expect({
          call: `${call.method} ${call.path}`,
          event: `${event.eventId} ${event.eventType}`,
          verdict,
        }).toEqual({
          call: `${call.method} ${call.path}`,
          event: `${event.eventId} ${event.eventType}`,
          verdict: 'accepted (200) or conflicted on an absent dependency (409)',
        });
      }
    }

    // The organization and group writes applied; every user bind was refused.
    const applied = outcomes.filter(outcome => outcome.status === 200);
    const refused = outcomes.filter(outcome => outcome.status === 409);

    expect(applied.map(outcome => `${outcome.call.method} ${outcome.call.path}`)).toEqual([
      `PUT /api/internal/scim/organizations/${DIRECTORY_ID}`,
      'PUT /api/internal/scim/sub-organizations/directory_group_01M6HD9895EBM5VG540FSMJ055',
      'PUT /api/internal/scim/sub-organizations/directory_group_01M6HD9P7ZTMT8BZAF5D6FNBAS',
      'PUT /api/internal/scim/sub-organizations/directory_group_01M6HD9P7ZTMT8BZAF5D6FNBAS',
      'PUT /api/internal/scim/sub-organizations/directory_group_01M6HD9P7ZTMT8BZAF5D6FNBAS',
      'PUT /api/internal/scim/sub-organizations/directory_group_01M6HD9895EBM5VG540FSMJ055',
      'PUT /api/internal/scim/sub-organizations/directory_group_01M6HD9895EBM5VG540FSMJ055',
    ]);

    // Every user bind, and there are five across the range — three
    // `dsync.user.created` plus the prerequisite upsert each
    // `dsync.group.user_added` emits ahead of the membership add. All refused:
    // the directory captured the Okta tenant hostname while delivering users at
    // `gmail.com` and `anaconda.com`, so the app refuses an address its
    // organization never proved it owns. Terminal, so the Worker parks those
    // events and makes progress.
    const userBinds = refused.filter(outcome => outcome.call.path.includes('/users/'));
    expect(userBinds).toHaveLength(5);
    for (const bind of userBinds) {
      // The code, not just the status class: this specific refusal — the
      // directory asserting an address at a domain its organization never
      // captured — is the configuration the recorded range exists to pin.
      expect({ path: bind.call.path, code: bind.code }).toEqual({
        path: bind.call.path,
        code: 'domain_not_captured',
      });
    }

    // The membership adds are calls the *live* dispatcher never issues: it
    // stops an event at its first non-applied call, and the user upsert ahead
    // of each of these was refused. The recorded fixture holds them because it
    // was recorded against a stub that accepts every route, which is what makes
    // it a complete record of what the dispatcher can emit. Replayed against a
    // database with no bound user, they conflict on exactly that — a dependency
    // absent, not a schema mismatch.
    const membershipAdds = refused.filter(
      outcome => outcome.call.path === '/api/internal/scim/memberships'
    );
    expect(membershipAdds).toHaveLength(2);
    for (const add of membershipAdds) {
      expect(add.code).toBe('user_not_found');
    }

    expect(applied.length + refused.length).toBe(14);
  }, 120_000);

  test('the replay leaves the organization shape the recorded directory produced', async () => {
    for (const call of dispatcherCallContract.events.flatMap(event => event.calls)) {
      await replay(call);
    }

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        parent: organizations.parent_organization_id,
        externalOrgId: organizations.external_org_id,
        directoryGroupId: organizations.directory_group_id,
        ssoDomain: organizations.sso_domain,
      })
      .from(organizations)
      .where(and(eq(organizations.directory_id, DIRECTORY_ID), isNull(organizations.deleted_at)));

    // One parent, two children, all under one directory.
    const parents = rows.filter(row => row.parent === null);
    expect(parents).toHaveLength(1);
    const parent = parents[0]!;
    expect(parent.name).toBe('z-corp');
    expect(parent.externalOrgId).toBe(WORKOS_ORGANIZATION_ID);
    // The Okta *tenant hostname*, which is what the directory captured — not an
    // email domain, which is why every user bind below is refused.
    expect(parent.ssoDomain).toBe(CAPTURED_DOMAIN);

    const children = rows
      .filter(row => row.parent !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(children.map(child => child.name)).toEqual(['kilo-admins', 'kilo-users']);
    expect(children.every(child => child.parent === parent.id)).toBe(true);
    expect(children.map(child => child.directoryGroupId).sort()).toEqual([
      'directory_group_01M6HD9895EBM5VG540FSMJ055',
      'directory_group_01M6HD9P7ZTMT8BZAF5D6FNBAS',
    ]);

    // Zero users and zero memberships: the refused binds provisioned nothing,
    // which is the end state the real run produced.
    const users = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(inArray(kilocode_users.external_id, DIRECTORY_USER_IDS));
    expect(users).toEqual([]);

    const memberships = await db
      .select({ id: organization_memberships.id })
      .from(organization_memberships)
      .where(
        inArray(
          organization_memberships.organization_id,
          rows.map(row => row.id)
        )
      );
    expect(memberships).toEqual([]);
  }, 120_000);

  test('replays the whole recorded range', () => {
    // A fixture trimmed to the calls that happen to pass would quietly shrink
    // the seam this replay covers.
    expect(dispatcherCallContract.events.map(event => event.eventId)).toEqual(
      workOSDirectoryEvents.events.map(event => event.id)
    );
  });
});
