import { describe, test, expect } from '@jest/globals';
import { eq, and, isNull } from 'drizzle-orm';
import { kilocode_users, user_admin_notes } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { hosted_domain_specials } from '@/lib/auth/constants';

const KILO_DOMAIN = hosted_domain_specials.kilocode_admin;

async function insertQualifyingAdmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    google_user_email: `qualifying-admin-${crypto.randomUUID()}@kilocode.ai`,
    hosted_domain: KILO_DOMAIN,
    is_admin: true,
    is_super_admin: true,
    ...overrides,
  });
}

async function insertGrandfatheredAdmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    google_user_email: `grandfathered-admin-${crypto.randomUUID()}@example.com`,
    hosted_domain: hosted_domain_specials.non_workspace_google_account,
    is_admin: true,
    is_super_admin: true,
    ...overrides,
  });
}

async function insertEligibleCandidate(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    google_user_email: `candidate-${crypto.randomUUID()}@kilocode.ai`,
    hosted_domain: KILO_DOMAIN,
    is_admin: false,
    ...overrides,
  });
}

async function getUserAdminNotes(userId: string) {
  return db.query.user_admin_notes.findMany({
    where: eq(user_admin_notes.kilo_user_id, userId),
  });
}

async function getUser(userId: string) {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
  if (!user) throw new Error(`Expected test user ${userId} to exist`);
  return user;
}

describe('admin.users.listPlatformAdmins', () => {
  test('non-admin callers cannot list admins', async () => {
    const nonAdmin = await insertTestUser({ is_admin: false });
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(caller.admin.users.listPlatformAdmins()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('includes both qualifying and grandfathered current admins', async () => {
    const qualifying = await insertQualifyingAdmin();
    const grandfathered = await insertGrandfatheredAdmin();
    await insertTestUser({ is_admin: false });

    const caller = await createCallerForUser(qualifying.id);
    const result = await caller.admin.users.listPlatformAdmins();

    const adminIds = result.admins.map(admin => admin.id);
    expect(adminIds).toContain(qualifying.id);
    expect(adminIds).toContain(grandfathered.id);
  });

  test('reports canManageAdmins true for a superadmin', async () => {
    const qualifying = await insertQualifyingAdmin();
    const caller = await createCallerForUser(qualifying.id);

    const result = await caller.admin.users.listPlatformAdmins();
    expect(result.canManageAdmins).toBe(true);
    expect(result.currentUserId).toBe(qualifying.id);
  });

  test('reports canManageAdmins false for an ordinary admin', async () => {
    const ordinaryAdmin = await insertGrandfatheredAdmin({ is_super_admin: false });
    const caller = await createCallerForUser(ordinaryAdmin.id);

    const result = await caller.admin.users.listPlatformAdmins();
    expect(result.canManageAdmins).toBe(false);
  });
});

describe('admin.users.searchPlatformAdminCandidates', () => {
  test('non-admin callers cannot search candidates', async () => {
    const nonAdmin = await insertTestUser({ is_admin: false });
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.users.searchPlatformAdminCandidates({ query: 'candidate' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('an ordinary admin cannot search candidates', async () => {
    const ordinaryAdmin = await insertGrandfatheredAdmin({ is_super_admin: false });
    const caller = await createCallerForUser(ordinaryAdmin.id);

    await expect(
      caller.admin.users.searchPlatformAdminCandidates({ query: 'candidate' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('returns only non-admin users satisfying both exact Kilo eligibility rules', async () => {
    const searchToken = crypto.randomUUID();
    const admin = await insertQualifyingAdmin();

    const eligible = await insertEligibleCandidate({
      google_user_email: `${searchToken}@kilocode.ai`,
    });
    const alreadyAdmin = await insertTestUser({
      google_user_email: `${searchToken}-already-admin@kilocode.ai`,
      hosted_domain: KILO_DOMAIN,
      is_admin: true,
    });
    const fakeLoginUser = await insertTestUser({
      google_user_email: `${searchToken}-fake@kilocode.ai`,
      hosted_domain: hosted_domain_specials.fake_devonly,
      is_admin: false,
    });
    const wrongDomainUser = await insertTestUser({
      google_user_email: `${searchToken}-wrong-domain@kilocode.ai`,
      hosted_domain: hosted_domain_specials.non_workspace_google_account,
      is_admin: false,
    });
    const wrongEmailUser = await insertTestUser({
      google_user_email: `${searchToken}@example.com`,
      hosted_domain: KILO_DOMAIN,
      is_admin: false,
    });
    const uppercaseEmailUser = await insertTestUser({
      google_user_email: `${searchToken.toUpperCase()}@Kilocode.ai`,
      hosted_domain: KILO_DOMAIN,
      is_admin: false,
    });
    const subdomainUser = await insertTestUser({
      google_user_email: `${searchToken}@sub.kilocode.ai`,
      hosted_domain: KILO_DOMAIN,
      is_admin: false,
    });
    const lookalikeDomainUser = await insertTestUser({
      google_user_email: `${searchToken}@notkilocode.ai`,
      hosted_domain: KILO_DOMAIN,
      is_admin: false,
    });

    const caller = await createCallerForUser(admin.id);
    const results = await caller.admin.users.searchPlatformAdminCandidates({
      query: searchToken,
    });

    const resultIds = results.map(user => user.id);
    expect(resultIds).toEqual([eligible.id]);
    expect(resultIds).not.toContain(alreadyAdmin.id);
    expect(resultIds).not.toContain(fakeLoginUser.id);
    expect(resultIds).not.toContain(wrongDomainUser.id);
    expect(resultIds).not.toContain(wrongEmailUser.id);
    expect(resultIds).not.toContain(uppercaseEmailUser.id);
    expect(resultIds).not.toContain(subdomainUser.id);
    expect(resultIds).not.toContain(lookalikeDomainUser.id);
  });

  test('escapes a literal underscore so it cannot act as a single-character SQL wildcard', async () => {
    const admin = await insertQualifyingAdmin();
    const token = crypto.randomUUID().replace(/-/g, '');

    const literalMatch = await insertEligibleCandidate({
      google_user_email: `${token}_probe@kilocode.ai`,
    });
    // If the underscore in the search query were passed to ILIKE unescaped, this
    // decoy (any single character standing in for "_") would incorrectly match too.
    const wildcardDecoy = await insertEligibleCandidate({
      google_user_email: `${token}Xprobe@kilocode.ai`,
    });

    const caller = await createCallerForUser(admin.id);
    const results = await caller.admin.users.searchPlatformAdminCandidates({
      query: `${token}_probe`,
    });

    const resultIds = results.map(user => user.id);
    expect(resultIds).toContain(literalMatch.id);
    expect(resultIds).not.toContain(wildcardDecoy.id);
    expect(results.length).toBeLessThanOrEqual(20);
  });
});

describe('admin.users.setPlatformAdminAccess — grant', () => {
  test('a superadmin can grant an eligible target without subordinate permissions', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertEligibleCandidate({
      web_session_pepper: 'before-grant-pepper',
      api_token_pepper: 'before-grant-api-pepper',
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.users.setPlatformAdminAccess({
      userId: target.id,
      isAdmin: true,
    });

    expect(result.changed).toBe(true);
    expect(result.user.is_admin).toBe(true);

    const updated = await getUser(target.id);
    expect(updated.is_admin).toBe(true);
    expect(updated.is_super_admin).toBe(false);
    expect(updated.can_view_sessions).toBe(false);
    expect(updated.can_manage_credits).toBe(false);
    expect(updated.web_session_pepper).not.toBe('before-grant-pepper');
    // Grant must rotate api_token_pepper so pre-grant bearer tokens can't
    // inherit admin capability.
    expect(updated.api_token_pepper).not.toBe('before-grant-api-pepper');

    const notes = await getUserAdminNotes(target.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note_content).toBe('Granted platform admin access.');
    expect(notes[0]?.admin_kilo_user_id).toBe(admin.id);
  });

  test('rejects granting an ineligible target even if submitted directly', async () => {
    const admin = await insertQualifyingAdmin();
    const ineligibleTarget = await insertTestUser({
      google_user_email: 'not-eligible@example.com',
      hosted_domain: hosted_domain_specials.non_workspace_google_account,
      is_admin: false,
    });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.setPlatformAdminAccess({ userId: ineligibleTarget.id, isAdmin: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const unchanged = await getUser(ineligibleTarget.id);
    expect(unchanged.is_admin).toBe(false);
  });

  test('an ordinary admin cannot grant', async () => {
    const grandfathered = await insertGrandfatheredAdmin({ is_super_admin: false });
    const target = await insertEligibleCandidate();
    const caller = await createCallerForUser(grandfathered.id);

    await expect(
      caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const unchanged = await getUser(target.id);
    expect(unchanged.is_admin).toBe(false);
  });

  test('repeated grant is an idempotent no-op with no second note or session rotation', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertEligibleCandidate();
    const caller = await createCallerForUser(admin.id);

    await caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true });
    const afterFirstGrant = await getUser(target.id);

    const secondResult = await caller.admin.users.setPlatformAdminAccess({
      userId: target.id,
      isAdmin: true,
    });

    expect(secondResult.changed).toBe(false);

    const afterSecondGrant = await getUser(target.id);
    expect(afterSecondGrant.web_session_pepper).toBe(afterFirstGrant.web_session_pepper);
    expect(afterSecondGrant.api_token_pepper).toBe(afterFirstGrant.api_token_pepper);

    const notes = await getUserAdminNotes(target.id);
    expect(notes).toHaveLength(1);
  });

  test('a redundant grant against an already-admin, ineligible (grandfathered) target is a no-op, not FORBIDDEN', async () => {
    const admin = await insertQualifyingAdmin();
    const grandfatheredTarget = await insertGrandfatheredAdmin({
      web_session_pepper: 'before-redundant-grant-pepper',
      api_token_pepper: 'before-redundant-grant-api-pepper',
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.users.setPlatformAdminAccess({
      userId: grandfatheredTarget.id,
      isAdmin: true,
    });

    expect(result.changed).toBe(false);

    const unchanged = await getUser(grandfatheredTarget.id);
    expect(unchanged.is_admin).toBe(true);
    expect(unchanged.web_session_pepper).toBe('before-redundant-grant-pepper');
    expect(unchanged.api_token_pepper).toBe('before-redundant-grant-api-pepper');

    const notes = await getUserAdminNotes(grandfatheredTarget.id);
    expect(notes).toHaveLength(0);
  });

  test('non-admin callers cannot grant', async () => {
    const nonAdmin = await insertTestUser({ is_admin: false });
    const target = await insertEligibleCandidate();
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('unknown target returns NOT_FOUND', async () => {
    const admin = await insertQualifyingAdmin();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.setPlatformAdminAccess({
        userId: 'does-not-exist',
        isAdmin: true,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('admin.users.setPlatformAdminAccess — revoke', () => {
  test('a superadmin can revoke another admin, clearing every subordinate permission', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin({
      can_manage_credits: true,
      can_view_sessions: true,
      web_session_pepper: 'before-revoke-pepper',
      api_token_pepper: 'before-revoke-api-pepper',
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.users.setPlatformAdminAccess({
      userId: target.id,
      isAdmin: false,
    });

    expect(result.changed).toBe(true);

    const updated = await getUser(target.id);
    expect(updated.is_admin).toBe(false);
    expect(updated.is_super_admin).toBe(false);
    expect(updated.can_view_sessions).toBe(false);
    expect(updated.can_manage_credits).toBe(false);
    expect(updated.web_session_pepper).not.toBe('before-revoke-pepper');
    // Revoke must rotate api_token_pepper so pre-revoke bearer tokens lose
    // their admin capability immediately.
    expect(updated.api_token_pepper).not.toBe('before-revoke-api-pepper');

    const notes = await getUserAdminNotes(target.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note_content).toBe('Revoked platform admin access.');
    expect(notes[0]?.admin_kilo_user_id).toBe(admin.id);
  });

  test('a grandfathered outside-domain superadmin can revoke another admin', async () => {
    const grandfathered = await insertGrandfatheredAdmin();
    const target = await insertQualifyingAdmin();
    const caller = await createCallerForUser(grandfathered.id);

    const result = await caller.admin.users.setPlatformAdminAccess({
      userId: target.id,
      isAdmin: false,
    });

    expect(result.changed).toBe(true);
    const updated = await getUser(target.id);
    expect(updated.is_admin).toBe(false);
  });

  test('self-revocation is forbidden', async () => {
    const admin = await insertQualifyingAdmin();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.setPlatformAdminAccess({ userId: admin.id, isAdmin: false })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const unchanged = await getUser(admin.id);
    expect(unchanged.is_admin).toBe(true);
  });

  test('repeated revoke is an idempotent no-op with no new note or session rotation', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin();
    const caller = await createCallerForUser(admin.id);

    await caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: false });
    const afterFirstRevoke = await getUser(target.id);

    const secondResult = await caller.admin.users.setPlatformAdminAccess({
      userId: target.id,
      isAdmin: false,
    });

    expect(secondResult.changed).toBe(false);

    const afterSecondRevoke = await getUser(target.id);
    expect(afterSecondRevoke.web_session_pepper).toBe(afterFirstRevoke.web_session_pepper);

    const notes = await getUserAdminNotes(target.id);
    expect(notes).toHaveLength(1);
  });

  test('non-admin callers cannot revoke', async () => {
    const nonAdmin = await insertTestUser({ is_admin: false });
    const target = await insertQualifyingAdmin();
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('serializes concurrent platform revocations so one unblocked superadmin remains', async () => {
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'isolated platform-revoke test' })
      .where(eq(kilocode_users.is_super_admin, true));
    const first = await insertQualifyingAdmin();
    const second = await insertQualifyingAdmin();
    const firstCaller = await createCallerForUser(first.id);
    const secondCaller = await createCallerForUser(second.id);

    const results = await Promise.allSettled([
      firstCaller.admin.users.setPlatformAdminAccess({ userId: second.id, isAdmin: false }),
      secondCaller.admin.users.setPlatformAdminAccess({ userId: first.id, isAdmin: false }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const remaining = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(
        and(
          eq(kilocode_users.is_admin, true),
          eq(kilocode_users.is_super_admin, true),
          isNull(kilocode_users.blocked_reason)
        )
      );
    expect(remaining).toHaveLength(1);
  });
});

describe('admin.users.setAdminPermissions', () => {
  test('ordinary admins cannot manage permissions', async () => {
    const ordinaryAdmin = await insertQualifyingAdmin({ is_super_admin: false });
    const target = await insertQualifyingAdmin();
    const caller = await createCallerForUser(ordinaryAdmin.id);

    await expect(
      caller.admin.users.setAdminPermissions({
        userId: target.id,
        permissions: { canViewSessions: true },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('requires at least one permission in the patch', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.setAdminPermissions({ userId: target.id, permissions: {} })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('applies only included fields, rotates credentials once, and attributes each note', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin({
      is_super_admin: false,
      can_view_sessions: false,
      can_manage_credits: true,
      web_session_pepper: 'before-permissions-web',
      api_token_pepper: 'before-permissions-api',
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.users.setAdminPermissions({
      userId: target.id,
      permissions: { isSuperadmin: true, canViewSessions: true },
    });

    expect(result.changed).toBe(true);
    expect(result.user.is_super_admin).toBe(true);
    expect(result.user.can_view_sessions).toBe(true);
    expect(result.user.can_manage_credits).toBe(true);

    const updated = await getUser(target.id);
    expect(updated.web_session_pepper).not.toBe('before-permissions-web');
    expect(updated.api_token_pepper).not.toBe('before-permissions-api');
    expect(updated.can_manage_credits).toBe(true);

    const notes = await getUserAdminNotes(target.id);
    expect(notes.map(note => note.note_content).sort()).toEqual([
      'Granted session viewer access.',
      'Granted superadmin access.',
    ]);
    expect(notes.every(note => note.admin_kilo_user_id === admin.id)).toBe(true);
  });

  test('permits self session-viewer and credit-manager changes but not self-superadmin changes', async () => {
    const admin = await insertQualifyingAdmin();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.setAdminPermissions({
        userId: admin.id,
        permissions: { canViewSessions: true, canManageCredits: true },
      })
    ).resolves.toMatchObject({ changed: true });

    await expect(
      caller.admin.users.setAdminPermissions({
        userId: admin.id,
        permissions: { isSuperadmin: false },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('rejects targets that are not platform admins', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertEligibleCandidate();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.setAdminPermissions({
        userId: target.id,
        permissions: { canViewSessions: true },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('repeated desired state is a no-op without credential rotation or duplicate notes', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin({
      can_view_sessions: true,
      web_session_pepper: 'no-op-web',
      api_token_pepper: 'no-op-api',
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.users.setAdminPermissions({
      userId: target.id,
      permissions: { canViewSessions: true },
    });

    expect(result.changed).toBe(false);
    const unchanged = await getUser(target.id);
    expect(unchanged.web_session_pepper).toBe('no-op-web');
    expect(unchanged.api_token_pepper).toBe('no-op-api');
    expect(await getUserAdminNotes(target.id)).toHaveLength(0);
  });

  test('revokes session-viewer and credit-manager access with fixed attributed notes', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin({
      can_view_sessions: true,
      can_manage_credits: true,
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.users.setAdminPermissions({
      userId: target.id,
      permissions: { canViewSessions: false, canManageCredits: false },
    });

    const updated = await getUser(target.id);
    expect(updated.can_view_sessions).toBe(false);
    expect(updated.can_manage_credits).toBe(false);
    const notes = await getUserAdminNotes(target.id);
    expect(notes.map(note => note.note_content).sort()).toEqual([
      'Revoked credit manager access.',
      'Revoked session viewer access.',
    ]);
    expect(notes.every(note => note.admin_kilo_user_id === admin.id)).toBe(true);
  });

  test('records granted credit-manager and revoked superadmin notes', async () => {
    const admin = await insertQualifyingAdmin();
    const target = await insertQualifyingAdmin({ is_super_admin: false });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.users.setAdminPermissions({
      userId: target.id,
      permissions: { canManageCredits: true, isSuperadmin: true },
    });
    await caller.admin.users.setAdminPermissions({
      userId: target.id,
      permissions: { isSuperadmin: false },
    });

    const notes = await getUserAdminNotes(target.id);
    expect(notes.map(note => note.note_content).sort()).toEqual([
      'Granted credit manager access.',
      'Granted superadmin access.',
      'Revoked superadmin access.',
    ]);
    expect(notes.every(note => note.admin_kilo_user_id === admin.id)).toBe(true);
  });

  test('blocked superadmins cannot manage permissions', async () => {
    const blocked = await insertQualifyingAdmin({ blocked_reason: 'security review' });
    const target = await insertQualifyingAdmin();
    const caller = await createCallerForUser(blocked.id);

    await expect(
      caller.admin.users.setAdminPermissions({
        userId: target.id,
        permissions: { canViewSessions: true },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('serializes concurrent revocations so one unblocked superadmin remains', async () => {
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'isolated concurrent-superadmin test' })
      .where(eq(kilocode_users.is_super_admin, true));
    const first = await insertQualifyingAdmin();
    const second = await insertQualifyingAdmin();
    const firstCaller = await createCallerForUser(first.id);
    const secondCaller = await createCallerForUser(second.id);

    const results = await Promise.allSettled([
      firstCaller.admin.users.setAdminPermissions({
        userId: second.id,
        permissions: { isSuperadmin: false },
      }),
      secondCaller.admin.users.setAdminPermissions({
        userId: first.id,
        permissions: { isSuperadmin: false },
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const remaining = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(
        and(
          eq(kilocode_users.is_admin, true),
          eq(kilocode_users.is_super_admin, true),
          isNull(kilocode_users.blocked_reason)
        )
      );
    expect(remaining).toHaveLength(1);
  });

  test('serializes mixed platform and permission revocations', async () => {
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'isolated mixed-superadmin test' })
      .where(eq(kilocode_users.is_super_admin, true));
    const first = await insertQualifyingAdmin();
    const second = await insertQualifyingAdmin();
    const firstCaller = await createCallerForUser(first.id);
    const secondCaller = await createCallerForUser(second.id);

    const results = await Promise.allSettled([
      firstCaller.admin.users.setPlatformAdminAccess({ userId: second.id, isAdmin: false }),
      secondCaller.admin.users.setAdminPermissions({
        userId: first.id,
        permissions: { isSuperadmin: false },
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const remaining = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(
        and(
          eq(kilocode_users.is_admin, true),
          eq(kilocode_users.is_super_admin, true),
          isNull(kilocode_users.blocked_reason)
        )
      );
    expect(remaining).toHaveLength(1);
  });
});

test('candidate search and grant eligibility never disagree for a hosted-domain-only mismatch', async () => {
  // Regression guard for the case=sensitive suffix check: a user whose email
  // ends with the Kilo suffix but whose hosted domain does not match must be
  // excluded from search AND rejected by the mutation if submitted directly.
  const admin = await insertQualifyingAdmin();
  const target = await insertTestUser({
    google_user_email: `mismatch-${crypto.randomUUID()}@kilocode.ai`,
    hosted_domain: hosted_domain_specials.non_workspace_google_account,
    is_admin: false,
  });
  const caller = await createCallerForUser(admin.id);

  const searchResults = await caller.admin.users.searchPlatformAdminCandidates({
    query: target.google_user_email,
  });
  expect(searchResults.map(u => u.id)).not.toContain(target.id);

  await expect(
    caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

// Ensure the note-column assertion helper stays honest about which table it reads.
test('user_admin_notes rows are scoped to the target user, not the actor', async () => {
  const admin = await insertQualifyingAdmin();
  const target = await insertEligibleCandidate();
  const caller = await createCallerForUser(admin.id);

  await caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true });

  const actorNotes = await getUserAdminNotes(admin.id);
  expect(actorNotes).toHaveLength(0);

  const targetNotes = await db.query.user_admin_notes.findMany({
    where: and(
      eq(user_admin_notes.kilo_user_id, target.id),
      eq(user_admin_notes.admin_kilo_user_id, admin.id)
    ),
  });
  expect(targetNotes).toHaveLength(1);
});
