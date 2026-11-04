import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  type Organization,
  type User,
  ai_gateway_config,
  api_kind,
  feature,
  finish_reason,
  microdollar_usage,
  microdollar_usage_metadata,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { REQUEST_LOGS_LIMIT } from './organization-request-logs-router';

type UsageInsert = typeof microdollar_usage.$inferInsert;
type MetadataInsert = typeof microdollar_usage_metadata.$inferInsert;

let owner: User;
let admin: User;
let billingManager: User;
let member: User;
let organization: Organization;
let otherOrganization: Organization;

async function enableRequestLogs(organizationIds: string[]) {
  const config = { organization_features: { request_logs: organizationIds } };
  await db
    .insert(ai_gateway_config)
    .values({ config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

async function featureId(name: string): Promise<number> {
  await db
    .insert(feature)
    .values({ feature: name })
    .onConflictDoNothing({ target: feature.feature });
  const [row] = await db
    .select({ id: feature.feature_id })
    .from(feature)
    .where(eq(feature.feature, name));
  return row.id;
}

async function finishReasonId(name: string): Promise<number> {
  await db
    .insert(finish_reason)
    .values({ finish_reason: name })
    .onConflictDoNothing({ target: finish_reason.finish_reason });
  const [row] = await db
    .select({ id: finish_reason.finish_reason_id })
    .from(finish_reason)
    .where(eq(finish_reason.finish_reason, name));
  return row.id;
}

async function apiKindId(name: 'chat_completions'): Promise<number> {
  await db
    .insert(api_kind)
    .values({ api_kind: name })
    .onConflictDoNothing({ target: api_kind.api_kind });
  const [row] = await db
    .select({ id: api_kind.api_kind_id })
    .from(api_kind)
    .where(eq(api_kind.api_kind, name));
  return row.id;
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function usageRow(overrides: Partial<UsageInsert> & { organization_id: string }): UsageInsert {
  return {
    id: randomUUID(),
    kilo_user_id: owner.id,
    cost: 1000,
    input_tokens: 100,
    output_tokens: 50,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: hoursAgo(1),
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    requested_model: 'anthropic/claude-sonnet-4.6',
    inference_provider: 'anthropic',
    ...overrides,
  };
}

function metadataRow(id: string, overrides: Partial<MetadataInsert> = {}): MetadataInsert {
  return { id, message_id: `msg-${id}`, ...overrides };
}

describe('organizations.requestLogs trpc router', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'owner-request-logs@example.com',
      google_user_name: 'Request Logs Owner',
    });
    admin = await insertTestUser({ google_user_name: 'Request Logs Admin' });
    billingManager = await insertTestUser({ google_user_name: 'Request Logs Billing Manager' });
    member = await insertTestUser({
      google_user_email: 'member-request-logs@example.com',
      google_user_name: 'Request Logs Member',
    });

    organization = await createTestOrganization('Request Logs Org', owner.id, 0, {}, false);
    otherOrganization = await createTestOrganization(
      'Other Request Logs Org',
      owner.id,
      0,
      {},
      false
    );

    await addUserToOrganization(organization.id, admin.id, 'admin');
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  afterEach(async () => {
    const usage = await db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(inArray(microdollar_usage.organization_id, [organization.id, otherOrganization.id]));
    const usageIds = usage.map(row => row.id);
    if (usageIds.length > 0) {
      await db
        .delete(microdollar_usage_metadata)
        .where(inArray(microdollar_usage_metadata.id, usageIds));
      await db.delete(microdollar_usage).where(inArray(microdollar_usage.id, usageIds));
    }
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  });

  afterAll(async () => {
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [organization.id, otherOrganization.id]));
  });

  describe('feature availability', () => {
    it('reports the feature as unavailable and rejects list and getDetails without it', async () => {
      const usage = usageRow({ organization_id: organization.id });
      await db.insert(microdollar_usage).values(usage);
      await enableRequestLogs([otherOrganization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.isAvailable({ organizationId: organization.id })
      ).resolves.toEqual({ available: false });
      await expect(
        caller.organizations.requestLogs.list({ organizationId: organization.id })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.organizations.requestLogs.getDetails({
          organizationId: organization.id,
          usageId: usage.id ?? '',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('reports the feature as unavailable when no gateway configuration exists', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.isAvailable({ organizationId: organization.id })
      ).resolves.toEqual({ available: false });
      await expect(
        caller.organizations.requestLogs.list({ organizationId: organization.id })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('reports the feature as available when it is enabled for the organization', async () => {
      await enableRequestLogs([organization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.isAvailable({ organizationId: organization.id })
      ).resolves.toEqual({ available: true });
      await expect(
        caller.organizations.requestLogs.list({ organizationId: organization.id })
      ).resolves.toEqual([]);
    });

    it('matches an organization id stored in upper case', async () => {
      await enableRequestLogs([organization.id.toUpperCase()]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.isAvailable({ organizationId: organization.id })
      ).resolves.toEqual({ available: true });
    });
  });

  describe('access control', () => {
    it('rejects a plain member with UNAUTHORIZED', async () => {
      await enableRequestLogs([organization.id]);
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.requestLogs.list({ organizationId: organization.id })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });
      await expect(
        caller.organizations.requestLogs.isAvailable({ organizationId: organization.id })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects a user outside the organization with UNAUTHORIZED', async () => {
      await enableRequestLogs([otherOrganization.id]);
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.requestLogs.list({ organizationId: otherOrganization.id })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
    });

    it.each([
      ['admin', () => admin],
      ['billing manager', () => billingManager],
    ])('allows an organization %s', async (_role, user) => {
      await enableRequestLogs([organization.id]);
      await db.insert(microdollar_usage).values(usageRow({ organization_id: organization.id }));
      const caller = await createCallerForUser(user().id);

      const rows = await caller.organizations.requestLogs.list({ organizationId: organization.id });
      expect(rows).toHaveLength(1);
    });
  });

  describe('list', () => {
    it("returns the organization's requests from the last 24 hours, newest first", async () => {
      await enableRequestLogs([organization.id, otherOrganization.id]);
      const vscodeFeatureId = await featureId('vscode-extension');

      const openRouter = usageRow({
        organization_id: organization.id,
        kilo_user_id: member.id,
        created_at: hoursAgo(1),
        provider: 'openrouter',
        inference_provider: 'deepinfra',
        model: 'moonshotai/kimi-k2',
        requested_model: 'kilo-auto/balanced',
        cost: 1234,
        input_tokens: 1000,
        output_tokens: 200,
        cache_hit_tokens: 300,
        has_error: false,
        project_id: 'project-a',
      });
      const vercel = usageRow({
        organization_id: organization.id,
        created_at: hoursAgo(2),
        provider: 'vercel',
        inference_provider: 'amazon-bedrock',
        model: 'anthropic/claude-sonnet-4.6',
        requested_model: null,
        has_error: true,
      });
      const custom = usageRow({
        organization_id: organization.id,
        created_at: hoursAgo(3),
        provider: 'custom',
        inference_provider: 'novita',
      });
      const withoutMetadata = usageRow({
        organization_id: organization.id,
        created_at: hoursAgo(23),
        inference_provider: null,
      });
      const tooOld = usageRow({ organization_id: organization.id, created_at: hoursAgo(25) });
      const otherOrgRow = usageRow({
        organization_id: otherOrganization.id,
        created_at: hoursAgo(1),
      });
      await db
        .insert(microdollar_usage)
        .values([custom, tooOld, openRouter, otherOrgRow, withoutMetadata, vercel]);
      await db.insert(microdollar_usage_metadata).values([
        metadataRow(openRouter.id ?? '', {
          is_user_byok: true,
          feature_id: vscodeFeatureId,
          latency: 123.5,
          generation_time: 4567,
        }),
        metadataRow(vercel.id ?? '', { is_user_byok: false, latency: 50, generation_time: 900 }),
        metadataRow(custom.id ?? '', { is_user_byok: false }),
      ]);

      const caller = await createCallerForUser(owner.id);
      const rows = await caller.organizations.requestLogs.list({ organizationId: organization.id });

      expect(rows.map(row => row.id)).toEqual([
        openRouter.id,
        vercel.id,
        custom.id,
        withoutMetadata.id,
      ]);
      expect(rows[0]).toEqual({
        id: openRouter.id,
        created_at: new Date(openRouter.created_at ?? '').toISOString(),
        user: { id: member.id, name: member.google_user_name, email: member.google_user_email },
        model: 'kilo-auto/balanced',
        provider: 'OpenRouter -> DeepInfra',
        cost_microdollars: 1234,
        input_tokens: 1000,
        output_tokens: 200,
        cache_hit_tokens: 300,
        is_user_byok: true,
        has_error: false,
        project_id: 'project-a',
        feature: 'vscode-extension',
        latency_ms: 123.5,
        generation_time_ms: 4567,
      });
      expect(rows[1]).toMatchObject({
        model: 'anthropic/claude-sonnet-4.6',
        provider: 'Vercel AI Gateway -> Amazon Bedrock',
        user: { id: owner.id, name: owner.google_user_name, email: owner.google_user_email },
        is_user_byok: false,
        has_error: true,
        feature: null,
        latency_ms: 50,
        generation_time_ms: 900,
      });
      expect(rows[2]).toMatchObject({ provider: 'Novita AI' });
      expect(rows[3]).toMatchObject({
        provider: null,
        is_user_byok: null,
        feature: null,
        latency_ms: null,
        generation_time_ms: null,
      });
      for (const row of rows) {
        expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    });

    it('returns null user details for a user that no longer exists', async () => {
      await enableRequestLogs([organization.id]);
      const deletedUserId = `deleted-user-${randomUUID()}`;
      await db
        .insert(microdollar_usage)
        .values(usageRow({ organization_id: organization.id, kilo_user_id: deletedUserId }));

      const caller = await createCallerForUser(owner.id);
      const [row] = await caller.organizations.requestLogs.list({
        organizationId: organization.id,
      });

      expect(row.user).toEqual({ id: deletedUserId, name: null, email: null });
    });

    it(`returns at most ${REQUEST_LOGS_LIMIT} requests`, async () => {
      await enableRequestLogs([organization.id]);
      const rows = Array.from({ length: REQUEST_LOGS_LIMIT + 1 }, (_, index) =>
        usageRow({
          organization_id: organization.id,
          created_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        })
      );
      await db.insert(microdollar_usage).values(rows);

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.requestLogs.list({
        organizationId: organization.id,
      });

      expect(result).toHaveLength(REQUEST_LOGS_LIMIT);
      expect(result.map(row => row.id)).toEqual(
        rows.slice(0, REQUEST_LOGS_LIMIT).map(row => row.id)
      );
    });
  });

  describe('getDetails', () => {
    it('returns NOT_FOUND for a request of another organization', async () => {
      await enableRequestLogs([organization.id, otherOrganization.id]);
      const otherOrgRow = usageRow({ organization_id: otherOrganization.id });
      await db.insert(microdollar_usage).values(otherOrgRow);

      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.requestLogs.getDetails({
          organizationId: organization.id,
          usageId: otherOrgRow.id ?? '',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns NOT_FOUND for a request older than 24 hours', async () => {
      await enableRequestLogs([organization.id]);
      const oldRow = usageRow({ organization_id: organization.id, created_at: hoursAgo(25) });
      await db.insert(microdollar_usage).values(oldRow);

      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.requestLogs.getDetails({
          organizationId: organization.id,
          usageId: oldRow.id ?? '',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns NOT_FOUND for an unknown request', async () => {
      await enableRequestLogs([organization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.getDetails({
          organizationId: organization.id,
          usageId: randomUUID(),
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a usage id that is not a UUID', async () => {
      await enableRequestLogs([organization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.getDetails({
          organizationId: organization.id,
          usageId: 'not-a-uuid',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns the request fields and not-configured metadata without an R2 bucket', async () => {
      await enableRequestLogs([organization.id]);
      const usage = usageRow({
        organization_id: organization.id,
        provider: 'openrouter',
        inference_provider: 'deepinfra',
        model: 'moonshotai/kimi-k2',
        requested_model: 'kilo-auto/balanced',
        cache_write_tokens: 42,
      });
      await db.insert(microdollar_usage).values(usage);
      await db.insert(microdollar_usage_metadata).values(
        metadataRow(usage.id ?? '', {
          status_code: 200,
          finish_reason_id: await finishReasonId('stop'),
          api_kind_id: await apiKindId('chat_completions'),
          streamed: true,
          cancelled: false,
          is_free: false,
          session_id: 'ses_request_logs_test',
        })
      );

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.requestLogs.getDetails({
        organizationId: organization.id,
        usageId: usage.id ?? '',
      });

      expect(result).toEqual({
        request: {
          model: 'moonshotai/kimi-k2',
          requested_model: 'kilo-auto/balanced',
          provider: 'openrouter',
          inference_provider: 'deepinfra',
          cache_write_tokens: 42,
          status_code: 200,
          finish_reason: 'stop',
          api_kind: 'chat_completions',
          streamed: true,
          cancelled: false,
          is_free: false,
          session_id: 'ses_request_logs_test',
          editor_name: null,
          mode: null,
          inference_region: null,
        },
        metadata: { status: 'not-configured' },
      });
    });
  });
});
