import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { organizations, user_data_exports, type User } from '@kilocode/db/schema';
import { createCallerForUser } from '@/routers/test-utils';
import { __test__ } from '@/routers/user-exports-router';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

let owner: User;
let stranger: User;

beforeAll(async () => {
  owner = await insertTestUser({
    google_user_email: 'data-export-owner@admin.example.com',
    is_admin: true,
  });
  stranger = await insertTestUser({ google_user_email: 'data-export-stranger@example.com' });
});

afterEach(async () => {
  await db.delete(user_data_exports).where(eq(user_data_exports.kilo_user_id, owner.id));
  await db.delete(user_data_exports).where(eq(user_data_exports.kilo_user_id, stranger.id));
});

describe('user exports router guards and serialization', () => {
  it('rejects API-token authentication for data export procedures', () => {
    expect(() => __test__.requireWebSession(true)).toThrow(TRPCError);
    expect(() => __test__.requireWebSession(false)).not.toThrow();
  });

  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(stranger.id);
    await expect(caller.userExports.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('normalizes database timestamp text into strict UTC ISO strings', () => {
    expect(
      __test__.serialize({
        id: 'f477a317-7f63-4ab0-b5cc-0066b8b7478d',
        subject_type: 'user',
        organization_id: null,
        organization_name: null,
        status: 'ready',
        requested_at: '2026-08-08 12:00:00+00',
        started_at: null,
        completed_at: '2026-08-08 12:01:00+00',
        expires_at: '2026-08-15 12:01:00+00',
        size_bytes: '2048',
        row_count: 42,
        failure_message: null,
        dispatch_generation: 0,
      })
    ).toMatchObject({
      requestedAt: '2026-08-08T12:00:00.000Z',
      sizeBytes: 2048,
      rowCount: 42,
    });
  });

  it('lists only exports owned by the authenticated user', async () => {
    await db.insert(user_data_exports).values([
      { kilo_user_id: owner.id, snapshot_at: new Date().toISOString() },
      { kilo_user_id: stranger.id, snapshot_at: new Date().toISOString() },
    ]);

    const caller = await createCallerForUser(owner.id);
    const result = await caller.userExports.list();

    expect(result.exports).toHaveLength(1);
    const [row] = await db
      .select({ id: user_data_exports.id })
      .from(user_data_exports)
      .where(eq(user_data_exports.kilo_user_id, owner.id));
    expect(result.exports[0]?.id).toBe(row.id);
  });

  it('returns redacted failure details for failed exports', async () => {
    await db.insert(user_data_exports).values({
      kilo_user_id: owner.id,
      snapshot_at: new Date().toISOString(),
      status: 'failed',
      last_error_redacted: 'The export could not be completed after multiple attempts.',
    });

    const result = await (await createCallerForUser(owner.id)).userExports.list();

    expect(result.exports[0]?.failureMessage).toBe(
      'The export could not be completed after multiple attempts.'
    );
  });

  it('uses the fixed August 2 08:40 UTC data cutoff for new exports', async () => {
    const caller = await createCallerForUser(owner.id);

    const requested = await caller.userExports.request();
    const [row] = await db
      .select({ snapshotAt: user_data_exports.snapshot_at })
      .from(user_data_exports)
      .where(eq(user_data_exports.id, requested.id));

    expect(new Date(row.snapshotAt).toISOString()).toBe('2026-08-02T08:40:00.000Z');
  });

  it('allows an immediate fresh request after a failed export', async () => {
    const [failed] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: owner.id,
        snapshot_at: new Date().toISOString(),
        status: 'failed',
        failure_code: 'queue_delivery_exhausted',
        last_error_redacted: 'The export could not be completed after multiple attempts.',
      })
      .returning({ id: user_data_exports.id });

    const requested = await (await createCallerForUser(owner.id)).userExports.request();

    expect(requested.id).not.toBe(failed.id);
    expect(requested.status).toBe('queued');
    const rows = await db
      .select({ id: user_data_exports.id, status: user_data_exports.status })
      .from(user_data_exports)
      .where(eq(user_data_exports.kilo_user_id, owner.id));
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: failed.id, status: 'failed' },
        { id: requested.id, status: 'queued' },
      ])
    );
  });

  it('allows a fresh request when a ready export exists but is past the throttle window', async () => {
    const pastThrottle = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const [ready] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: owner.id,
        snapshot_at: pastThrottle,
        status: 'ready',
        r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
        size_bytes: 1,
        requested_at: pastThrottle,
        completed_at: pastThrottle,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning({ id: user_data_exports.id });

    const requested = await (await createCallerForUser(owner.id)).userExports.request();

    // A still-downloadable ready export must not short-circuit a new request.
    expect(requested.id).not.toBe(ready.id);
    expect(requested.status).toBe('queued');
  });

  it('records the organization as the subject, leaving the requester as who asked', async () => {
    const organization = await createTestOrganization('Export Org Subject', owner.id, 0);
    const caller = await createCallerForUser(owner.id);

    const requested = await caller.userExports.requestOrganization({
      organizationId: organization.id,
    });

    expect(requested.subjectType).toBe('organization');
    expect(requested.organizationId).toBe(organization.id);
    const [row] = await db
      .select({
        subjectType: user_data_exports.subject_type,
        organizationId: user_data_exports.organization_id,
        kiloUserId: user_data_exports.kilo_user_id,
      })
      .from(user_data_exports)
      .where(eq(user_data_exports.id, requested.id));
    // The requester is recorded, but the subject is the organization. Confusing the two
    // is what would make an organization export return the admin's own rows.
    expect(row).toEqual({
      subjectType: 'organization',
      organizationId: organization.id,
      kiloUserId: owner.id,
    });
  });

  // The two subjects are tracked separately, so a personal export generating must not
  // consume the organization's slot or vice versa.
  it('allows a personal and an organization export to be active at once', async () => {
    const organization = await createTestOrganization('Export Org Parallel', owner.id, 0);
    const caller = await createCallerForUser(owner.id);

    const personal = await caller.userExports.request();
    const organizationExport = await caller.userExports.requestOrganization({
      organizationId: organization.id,
    });

    expect(personal.id).not.toBe(organizationExport.id);
    expect(personal.status).toBe('queued');
    expect(organizationExport.status).toBe('queued');
  });

  // Keyed on the organization rather than the requester, so a second admin pressing the
  // button joins the export already running instead of generating a duplicate copy.
  it('returns the in-flight organization export rather than starting a second', async () => {
    const organization = await createTestOrganization('Export Org Single', owner.id, 0);
    const caller = await createCallerForUser(owner.id);

    const first = await caller.userExports.requestOrganization({
      organizationId: organization.id,
    });
    const second = await caller.userExports.requestOrganization({
      organizationId: organization.id,
    });

    expect(second.id).toBe(first.id);
    const rows = await db
      .select({ id: user_data_exports.id })
      .from(user_data_exports)
      .where(eq(user_data_exports.organization_id, organization.id));
    expect(rows).toHaveLength(1);
  });

  it('lists an organization export alongside personal ones and labels each', async () => {
    const organization = await createTestOrganization('Export Org Listing', owner.id, 0);
    const caller = await createCallerForUser(owner.id);
    await caller.userExports.request();
    await caller.userExports.requestOrganization({ organizationId: organization.id });

    const result = await caller.userExports.list();

    expect(
      result.exports.map(record => [record.subjectType, record.organizationName]).sort()
    ).toEqual([
      ['organization', 'Export Org Listing'],
      ['user', null],
    ]);
  });

  it('offers only organizations the caller may export', async () => {
    const organization = await createTestOrganization('Export Org Offered', owner.id, 0);

    const result = await (
      await createCallerForUser(owner.id)
    ).userExports.exportableOrganizations();

    expect(result.organizations).toEqual(
      expect.arrayContaining([{ id: organization.id, name: 'Export Org Offered' }])
    );
  });

  // An owner of a parent organization inherits access to its children, so the request
  // path accepts a child the caller has no direct membership in. Offering only direct
  // memberships would let that request succeed and then leave the export invisible.
  it('offers a child organization reached through a parent organization role', async () => {
    const parent = await createTestOrganization('Export Org Parent', owner.id, 0);
    const child = await createTestOrganization('Export Org Child', stranger.id, 0);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));

    const caller = await createCallerForUser(owner.id);
    const offered = await caller.userExports.exportableOrganizations();

    expect(offered.organizations.map(organization => organization.id)).toEqual(
      expect.arrayContaining([parent.id, child.id])
    );

    // The export requested on that inherited access is listed back to the requester.
    const requested = await caller.userExports.requestOrganization({ organizationId: child.id });
    const listed = await caller.userExports.list();
    expect(listed.exports.map(record => record.id)).toContain(requested.id);
  });

  // The database refuses a subject it could not scope a query on, independently of the
  // router. A job reaching the generator as 'organization' with no id would otherwise
  // have to be caught at read time, after the export had already been admitted.
  it('rejects an export whose subject and organization disagree', async () => {
    await expect(
      db.insert(user_data_exports).values({
        kilo_user_id: owner.id,
        snapshot_at: new Date().toISOString(),
        subject_type: 'organization',
        organization_id: null,
      })
    ).rejects.toThrow();

    const organization = await createTestOrganization('Export Org Shape', owner.id, 0);
    await expect(
      db.insert(user_data_exports).values({
        kilo_user_id: owner.id,
        snapshot_at: new Date().toISOString(),
        subject_type: 'user',
        organization_id: organization.id,
      })
    ).rejects.toThrow();
  });

  // The cursor names a row by id, so it has to be resolved under the caller's own
  // visibility. An unscoped lookup would page the caller's rows relative to a row they
  // cannot see, turning the cursor into an ordering oracle over other people's exports.
  it('ignores a cursor naming an export the caller cannot see', async () => {
    const [hidden] = await db
      .insert(user_data_exports)
      .values({ kilo_user_id: stranger.id, snapshot_at: new Date().toISOString() })
      .returning({ id: user_data_exports.id });
    await db.insert(user_data_exports).values({
      kilo_user_id: owner.id,
      snapshot_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(owner.id);
    const unpaged = await caller.userExports.list();
    const paged = await caller.userExports.list({ cursor: hidden.id });

    expect(unpaged.exports).toHaveLength(1);
    // Fails closed: an unresolvable cursor yields NULL and matches nothing, rather than
    // silently restarting at the first page.
    expect(paged.exports).toHaveLength(0);
  });

  it('does not authorize another user or an expired export for download', async () => {
    const [ready] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: stranger.id,
        snapshot_at: new Date().toISOString(),
        status: 'ready',
        r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
        size_bytes: 1,
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning();
    const [expired] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: owner.id,
        snapshot_at: new Date().toISOString(),
        status: 'ready',
        r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
        size_bytes: 1,
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .returning();
    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.createDownload({ exportId: ready.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller.userExports.createDownload({ exportId: expired.id })).rejects.toMatchObject(
      { code: 'NOT_FOUND' }
    );
  });
});
