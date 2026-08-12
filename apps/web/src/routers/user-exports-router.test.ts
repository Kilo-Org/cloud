import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { DOWNLOAD_CODE_LENGTH } from '@/app/(app)/data-exports/data-export-contract';
import { db } from '@/lib/drizzle';
import {
  magic_link_tokens,
  organizations,
  user_data_exports,
  type User,
} from '@kilocode/db/schema';
import { createCallerForUser } from '@/routers/test-utils';
import { __test__ } from '@/routers/user-exports-router';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

// Partial mocks: `@/lib/email` also exports the template registry that sibling
// routers read at import time, so the real module must stay intact.
jest.mock('@/lib/email', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/email');
  return { ...actual, sendDataExportDownloadCodeEmail: jest.fn() };
});
// The firewall check needs a request scope, which the tRPC caller does not have.
jest.mock('@/lib/auth/data-export-download-code-rate-limit', () => ({
  isDataExportDownloadCodeRateLimited: jest.fn(),
}));
jest.mock('@/lib/user-data-export-worker-client', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/user-data-export-worker-client'
  );
  return {
    ...actual,
    dispatchUserDataExport: jest.fn(),
    requestUserDataExportDownload: jest.fn(),
  };
});

import { isDataExportDownloadCodeRateLimited } from '@/lib/auth/data-export-download-code-rate-limit';
import { sendDataExportDownloadCodeEmail } from '@/lib/email';
import { requestUserDataExportDownload } from '@/lib/user-data-export-worker-client';

const mockRateLimited = jest.mocked(isDataExportDownloadCodeRateLimited);
const mockSendCode = jest.mocked(sendDataExportDownloadCodeEmail);
const mockWorkerDownload = jest.mocked(requestUserDataExportDownload);

const OWNER_EMAIL = 'data-export-owner@admin.example.com';

let owner: User;
let stranger: User;

beforeAll(async () => {
  owner = await insertTestUser({
    google_user_email: OWNER_EMAIL,
    is_admin: true,
  });
  stranger = await insertTestUser({ google_user_email: 'data-export-stranger@example.com' });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRateLimited.mockResolvedValue(false);
  mockSendCode.mockResolvedValue({ sent: true });
  mockWorkerDownload.mockResolvedValue({
    kind: 'available',
    downloadUrl: 'https://r2.example.com/signed-export',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
});

afterEach(async () => {
  await db.delete(user_data_exports).where(eq(user_data_exports.kilo_user_id, owner.id));
  await db.delete(user_data_exports).where(eq(user_data_exports.kilo_user_id, stranger.id));
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE email = ${OWNER_EMAIL}`);
});

async function insertReadyExport(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(user_data_exports)
    .values({
      kilo_user_id: kiloUserId,
      snapshot_at: new Date().toISOString(),
      status: 'ready',
      r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
      size_bytes: 1,
      completed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    .returning({ id: user_data_exports.id });
  return row.id;
}

async function insertReadyOrganizationExport(
  requesterId: string,
  organizationId: string
): Promise<string> {
  const [row] = await db
    .insert(user_data_exports)
    .values({
      kilo_user_id: requesterId,
      subject_type: 'organization',
      organization_id: organizationId,
      snapshot_at: new Date().toISOString(),
      status: 'ready',
      r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
      size_bytes: 1,
      completed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    .returning({ id: user_data_exports.id });
  return row.id;
}

/** Reads the emailed code out of the mocked sender. */
function lastEmailedCode(): string {
  const call = mockSendCode.mock.calls.at(-1);
  if (!call) throw new Error('no download code email was sent');
  return call[1].code;
}

async function requestCode(kiloUserId: string, exportId: string) {
  const caller = await createCallerForUser(kiloUserId);
  const { challengeId } = await caller.userExports.requestDownloadCode({ exportId });
  return { caller, challengeId, code: lastEmailedCode() };
}

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
  // Membership rows outlive a soft-deleted organization, so a former admin can still
  // name its id directly even though it never appears in the offered list.
  it('refuses to export a soft-deleted organization', async () => {
    const organization = await createTestOrganization('Export Org Deleted', owner.id, 0);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.userExports.requestOrganization({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const offered = await caller.userExports.exportableOrganizations();
    expect(offered.organizations.map(item => item.id)).not.toContain(organization.id);
  });

  // The download path answers on an export id the caller supplied, so an authorization
  // failure must be indistinguishable from a missing export. UNAUTHORIZED would confirm
  // the id exists.
  it('reports an inaccessible organization export as not found, not unauthorized', async () => {
    const organization = await createTestOrganization('Export Org Hidden', stranger.id, 0);
    const exportId = await insertReadyOrganizationExport(stranger.id, organization.id);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.requestDownloadCode({ exportId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

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

  // The download gate scopes personal exports on kilo_user_id. An organization's
  // export belongs to the organization rather than to whoever pressed the button, so
  // it has to be reachable by an authorised colleague — scoping it the same way would
  // report it as missing to everyone but the requester.
  it('emails a download code for an organization export to an authorized colleague', async () => {
    const organization = await createTestOrganization('Export Org Download', owner.id, 0);
    const colleague = await insertTestUser({
      google_user_email: 'data-export-colleague@admin.example.com',
      is_admin: true,
    });
    const exportId = await insertReadyOrganizationExport(owner.id, organization.id);

    const caller = await createCallerForUser(colleague.id);
    const result = await caller.userExports.requestDownloadCode({ exportId });

    expect(result.challengeId).toBeDefined();
    // Delivered to whoever is downloading, not to whoever requested the export.
    expect(mockSendCode).toHaveBeenCalledWith(
      'data-export-colleague@admin.example.com',
      expect.anything()
    );
  });

  it('emails a download code without ever returning it to the caller', async () => {
    const exportId = await insertReadyExport(owner.id);

    const caller = await createCallerForUser(owner.id);
    const result = await caller.userExports.requestDownloadCode({ exportId });

    expect(mockSendCode).toHaveBeenCalledWith(OWNER_EMAIL, {
      code: expect.stringMatching(new RegExp(`^\\d{${DOWNLOAD_CODE_LENGTH}}$`)),
      expiresInMinutes: 10,
    });
    expect(JSON.stringify(result)).not.toContain(lastEmailedCode());
  });

  it('stops emailing codes to a rate-limited account', async () => {
    const exportId = await insertReadyExport(owner.id);
    mockRateLimited.mockResolvedValue(true);

    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.requestDownloadCode({ exportId })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockRateLimited).toHaveBeenCalledWith(owner.id);
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('does not email a code for an export the caller does not own', async () => {
    const exportId = await insertReadyExport(stranger.id);

    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.requestDownloadCode({ exportId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('drops the code and reports failure when the email cannot be delivered', async () => {
    const exportId = await insertReadyExport(owner.id);
    mockSendCode.mockResolvedValue({ sent: false, reason: 'provider_not_configured' });

    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.requestDownloadCode({ exportId })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    const rows = await db
      .select({ token_hash: magic_link_tokens.token_hash })
      .from(magic_link_tokens)
      .where(eq(magic_link_tokens.email, OWNER_EMAIL));
    expect(rows).toHaveLength(0);
  });

  it('drops the code when the mail provider throws instead of reporting failure', async () => {
    const exportId = await insertReadyExport(owner.id);
    // Mailgun rejects on an API or network failure rather than returning `sent: false`.
    mockSendCode.mockRejectedValue(new Error('mailgun unavailable'));

    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.requestDownloadCode({ exportId })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    const rows = await db
      .select({ token_hash: magic_link_tokens.token_hash })
      .from(magic_link_tokens)
      .where(eq(magic_link_tokens.email, OWNER_EMAIL));
    expect(rows).toHaveLength(0);

    // No leftover row means the cooldown does not report a code that never arrived.
    mockSendCode.mockResolvedValue({ sent: true });
    await expect(caller.userExports.requestDownloadCode({ exportId })).resolves.toMatchObject({
      challengeId: expect.any(String),
    });
  });

  it('refuses to sign a download without the emailed code', async () => {
    const exportId = await insertReadyExport(owner.id);
    const { caller, challengeId, code } = await requestCode(owner.id, exportId);
    const wrongCode = String((Number(code) + 1) % 10 ** DOWNLOAD_CODE_LENGTH).padStart(
      DOWNLOAD_CODE_LENGTH,
      '0'
    );

    await expect(
      caller.userExports.createDownload({ exportId, challengeId, code: wrongCode })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockWorkerDownload).not.toHaveBeenCalled();
  });

  it('signs a download once the emailed code is presented, then refuses to reuse it', async () => {
    const exportId = await insertReadyExport(owner.id);
    const { caller, challengeId, code } = await requestCode(owner.id, exportId);

    await expect(
      caller.userExports.createDownload({ exportId, challengeId, code })
    ).resolves.toMatchObject({ downloadUrl: 'https://r2.example.com/signed-export' });

    // The signed URL is a bearer capability, so the code must not mint a second one.
    await expect(
      caller.userExports.createDownload({ exportId, challengeId, code })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockWorkerDownload).toHaveBeenCalledTimes(1);
  });

  it('does not accept a code minted for a different export', async () => {
    const targetExportId = await insertReadyExport(owner.id);
    const otherExportId = await insertReadyExport(owner.id);
    const { caller, challengeId, code } = await requestCode(owner.id, otherExportId);

    await expect(
      caller.userExports.createDownload({ exportId: targetExportId, challengeId, code })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockWorkerDownload).not.toHaveBeenCalled();
  });

  it('keeps the code usable when signing is unavailable', async () => {
    const exportId = await insertReadyExport(owner.id);
    const { caller, challengeId, code } = await requestCode(owner.id, exportId);
    mockWorkerDownload.mockResolvedValueOnce({ kind: 'unavailable', reason: 'not_configured' });

    await expect(
      caller.userExports.createDownload({ exportId, challengeId, code })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // No capability was handed out, so a retry must not cost the user a new code.
    await expect(
      caller.userExports.createDownload({ exportId, challengeId, code })
    ).resolves.toMatchObject({ downloadUrl: 'https://r2.example.com/signed-export' });
  });

  it('throttles repeat code emails for the same account', async () => {
    const exportId = await insertReadyExport(owner.id);
    const caller = await createCallerForUser(owner.id);

    await caller.userExports.requestDownloadCode({ exportId });

    await expect(caller.userExports.requestDownloadCode({ exportId })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockSendCode).toHaveBeenCalledTimes(1);
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
    // Ownership and freshness are checked before the code, so these never reach it.
    const unusedCode = { code: '0'.repeat(DOWNLOAD_CODE_LENGTH), challengeId: crypto.randomUUID() };

    await expect(
      caller.userExports.createDownload({ exportId: ready.id, ...unusedCode })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.userExports.createDownload({ exportId: expired.id, ...unusedCode })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
