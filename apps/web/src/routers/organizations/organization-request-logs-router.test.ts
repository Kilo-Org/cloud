import { createCallerForUser } from '@/routers/test-utils';
import { provisionEnkryptUsagePartitions } from '@/lib/usage-partitions';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  type Organization,
  type User,
  ai_gateway_config,
  api_kind,
  auto_model,
  enkrypt_usage,
  enkrypt_usage_decision,
  enkrypt_usage_guardrail,
  feature,
  finish_reason,
  microdollar_usage,
  microdollar_usage_metadata,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { REQUEST_LOGS_LIMIT } from '@/lib/request-logs/filters';

type UsageInsert = typeof microdollar_usage.$inferInsert;
type MetadataInsert = typeof microdollar_usage_metadata.$inferInsert;
type EnkryptUsageInsert = typeof enkrypt_usage.$inferInsert;
type ApiKind = (typeof api_kind.$inferInsert)['api_kind'];
type EnkryptDecision = (typeof enkrypt_usage_decision.$inferInsert)['decision'];
type ListFilters = { startTime?: string; userId?: string; modelPrefix?: string };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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

async function autoModelId(name: string): Promise<number> {
  await db
    .insert(auto_model)
    .values({ auto_model: name })
    .onConflictDoNothing({ target: auto_model.auto_model });
  const [row] = await db
    .select({ id: auto_model.auto_model_id })
    .from(auto_model)
    .where(eq(auto_model.auto_model, name));
  return row.id;
}

async function apiKindId(name: ApiKind): Promise<number> {
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
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE_MS).toISOString();
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function isoWithPlusTwoOffset(ms: number): string {
  return `${new Date(ms + 2 * HOUR_MS).toISOString().slice(0, -1)}+02:00`;
}

function usageRow(
  overrides: Partial<UsageInsert> & { organization_id: string }
): UsageInsert & { id: string; created_at: string } {
  return {
    id: randomUUID(),
    kilo_user_id: owner.id,
    cost: 1000,
    input_tokens: 100,
    output_tokens: 50,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: minutesAgo(5),
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

async function listIds(filters: ListFilters = {}): Promise<string[]> {
  const caller = await createCallerForUser(owner.id);
  const rows = await caller.organizations.requestLogs.list({
    organizationId: organization.id,
    ...filters,
  });
  return rows.map(row => row.id);
}

async function enkryptDecisionId(decision: EnkryptDecision): Promise<number> {
  await db
    .insert(enkrypt_usage_decision)
    .values({ decision })
    .onConflictDoNothing({ target: enkrypt_usage_decision.decision });
  const [row] = await db
    .select({ id: enkrypt_usage_decision.decision_id })
    .from(enkrypt_usage_decision)
    .where(eq(enkrypt_usage_decision.decision, decision));
  return row.id;
}

async function enkryptGuardrailId(guardrail: 'input' | 'output'): Promise<number> {
  await db
    .insert(enkrypt_usage_guardrail)
    .values({ guardrail })
    .onConflictDoNothing({ target: enkrypt_usage_guardrail.guardrail });
  const [row] = await db
    .select({ id: enkrypt_usage_guardrail.guardrail_id })
    .from(enkrypt_usage_guardrail)
    .where(eq(enkrypt_usage_guardrail.guardrail, guardrail));
  return row.id;
}

type EnkryptLookups = {
  apiKind: Record<'chat_completions' | 'messages' | 'responses', number>;
  decision: Record<'allowed' | 'blocked' | 'error', number>;
  guardrail: Record<'input' | 'output', number>;
};

async function enkryptLookups(): Promise<EnkryptLookups> {
  return {
    apiKind: {
      chat_completions: await apiKindId('chat_completions'),
      messages: await apiKindId('messages'),
      responses: await apiKindId('responses'),
    },
    decision: {
      allowed: await enkryptDecisionId('allowed'),
      blocked: await enkryptDecisionId('blocked'),
      error: await enkryptDecisionId('error'),
    },
    guardrail: {
      input: await enkryptGuardrailId('input'),
      output: await enkryptGuardrailId('output'),
    },
  };
}

function enkryptRow(
  lookups: EnkryptLookups,
  overrides: Partial<EnkryptUsageInsert> & { organization_id: string }
): EnkryptUsageInsert & { id: string; created_at: string } {
  return {
    id: randomUUID(),
    kilo_user_id: owner.id,
    api_kind_id: lookups.apiKind.chat_completions,
    decision_id: lookups.decision.allowed,
    enkrypt_credits_cost: 1,
    charged_microdollars: 100,
    created_at: hoursAgo(1),
    ...overrides,
  };
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
    await db
      .delete(enkrypt_usage)
      .where(inArray(enkrypt_usage.organization_id, [organization.id, otherOrganization.id]));
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
        caller.organizations.requestLogs.list({
          organizationId: organization.id,
          startTime: minutesAgo(10),
          userId: owner.id,
          modelPrefix: 'anthropic/',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.organizations.requestLogs.getDetails({
          organizationId: organization.id,
          usageId: usage.id,
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
        caller.organizations.requestLogs.list({
          organizationId: organization.id,
          userId: member.id,
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
      const filtered = await caller.organizations.requestLogs.list({
        organizationId: organization.id,
        userId: owner.id,
        modelPrefix: 'anthropic/',
      });
      expect(filtered).toHaveLength(1);
    });
  });

  describe('list', () => {
    it("returns the organization's requests from the last hour, newest first", async () => {
      await enableRequestLogs([organization.id, otherOrganization.id]);
      const vscodeFeatureId = await featureId('vscode-extension');

      const openRouter = usageRow({
        organization_id: organization.id,
        kilo_user_id: member.id,
        created_at: minutesAgo(10),
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
        created_at: minutesAgo(30),
        provider: 'vercel',
        inference_provider: 'amazon-bedrock',
        model: 'anthropic/claude-sonnet-4.6',
        requested_model: null,
        has_error: true,
      });
      const withoutMetadata = usageRow({
        organization_id: organization.id,
        created_at: minutesAgo(45),
        inference_provider: null,
      });
      const custom = usageRow({
        organization_id: organization.id,
        created_at: minutesAgo(59),
        provider: 'custom',
        inference_provider: 'novita',
      });
      const tooOld = usageRow({ organization_id: organization.id, created_at: minutesAgo(61) });
      const otherOrgRow = usageRow({
        organization_id: otherOrganization.id,
        created_at: minutesAgo(10),
      });
      await db
        .insert(microdollar_usage)
        .values([custom, tooOld, openRouter, otherOrgRow, withoutMetadata, vercel]);
      await db.insert(microdollar_usage_metadata).values([
        metadataRow(openRouter.id, {
          is_user_byok: true,
          feature_id: vscodeFeatureId,
          latency: 123.5,
          generation_time: 4567,
        }),
        metadataRow(vercel.id, { is_user_byok: false, latency: 50, generation_time: 900 }),
        metadataRow(custom.id, { is_user_byok: false }),
      ]);

      const caller = await createCallerForUser(owner.id);
      const rows = await caller.organizations.requestLogs.list({ organizationId: organization.id });

      expect(rows.map(row => row.id)).toEqual([
        openRouter.id,
        vercel.id,
        withoutMetadata.id,
        custom.id,
      ]);
      expect(rows[0]).toEqual({
        id: openRouter.id,
        created_at: new Date(openRouter.created_at).toISOString(),
        user: { id: member.id, name: member.google_user_name, email: member.google_user_email },
        model: 'kilo-auto/balanced',
        provider: 'DeepInfra',
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
        provider: 'Amazon Bedrock',
        user: { id: owner.id, name: owner.google_user_name, email: owner.google_user_email },
        is_user_byok: false,
        has_error: true,
        feature: null,
        latency_ms: 50,
        generation_time_ms: 900,
      });
      expect(rows[2]).toMatchObject({
        provider: null,
        is_user_byok: null,
        feature: null,
        latency_ms: null,
        generation_time_ms: null,
      });
      expect(rows[3]).toMatchObject({ provider: 'Novita AI' });
      for (const row of rows) {
        expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    });

    describe.each(['openai-chatgpt', 'claude-billing'])('%s legacy requests', provider => {
      it.each([false, true])('returns BYOK when metadata exists=%s', async hasMetadata => {
        await enableRequestLogs([organization.id]);
        const usage = usageRow({ organization_id: organization.id, provider });
        await db.insert(microdollar_usage).values(usage);
        if (hasMetadata) {
          await db
            .insert(microdollar_usage_metadata)
            .values(metadataRow(usage.id, { is_user_byok: false }));
        }

        const caller = await createCallerForUser(owner.id);
        const [row] = await caller.organizations.requestLogs.list({
          organizationId: organization.id,
        });

        expect(row.is_user_byok).toBe(true);
        const storedMetadata = await db
          .select({ is_user_byok: microdollar_usage_metadata.is_user_byok })
          .from(microdollar_usage_metadata)
          .where(eq(microdollar_usage_metadata.id, usage.id));
        expect(storedMetadata).toEqual(hasMetadata ? [{ is_user_byok: false }] : []);
      });
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
          created_at: isoAt(Date.now() - (index + 1) * 10_000),
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

    describe('startTime', () => {
      it('returns the hour leading up to the start time, including the start and excluding the hour boundary', async () => {
        await enableRequestLogs([organization.id]);
        const start = Date.now() - 3 * HOUR_MS - 123;
        const atStart = usageRow({ organization_id: organization.id, created_at: isoAt(start) });
        const justAfterStart = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start + 1),
        });
        const atHourBoundary = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start - HOUR_MS),
        });
        const justInsideHourBoundary = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start - HOUR_MS + 1),
        });
        const middle = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start - 30 * MINUTE_MS),
        });
        const recent = usageRow({
          organization_id: organization.id,
          created_at: isoAt(Date.now()),
        });
        await db
          .insert(microdollar_usage)
          .values([
            atHourBoundary,
            recent,
            justInsideHourBoundary,
            atStart,
            middle,
            justAfterStart,
          ]);

        await expect(listIds({ startTime: isoAt(start) })).resolves.toEqual([
          atStart.id,
          middle.id,
          justInsideHourBoundary.id,
        ]);
        await expect(listIds()).resolves.toEqual([recent.id]);
      });

      it('interprets a start time with a non-UTC offset as the same instant', async () => {
        await enableRequestLogs([organization.id]);
        const start = Date.now() - 4 * HOUR_MS;
        const inside = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start - 30 * MINUTE_MS),
        });
        const atStart = usageRow({ organization_id: organization.id, created_at: isoAt(start) });
        const after = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start + 30 * MINUTE_MS),
        });
        const before = usageRow({
          organization_id: organization.id,
          created_at: isoAt(start - 90 * MINUTE_MS),
        });
        await db.insert(microdollar_usage).values([inside, atStart, after, before]);

        const startTime = isoWithPlusTwoOffset(start);
        expect(startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+02:00$/);
        expect(new Date(startTime).getTime()).toBe(start);
        await expect(listIds({ startTime })).resolves.toEqual([atStart.id, inside.id]);
      });

      it.each([
        ['is not an ISO timestamp', () => 'yesterday'],
        ['has no offset', () => new Date(Date.now() - HOUR_MS).toISOString().slice(0, -1)],
        ['is older than 365 days', () => isoAt(Date.now() - 366 * DAY_MS)],
        ['is more than 5 minutes in the future', () => isoAt(Date.now() + HOUR_MS)],
      ])('rejects a start time that %s with BAD_REQUEST', async (_case, startTime) => {
        await enableRequestLogs([organization.id]);
        const caller = await createCallerForUser(owner.id);

        await expect(
          caller.organizations.requestLogs.list({
            organizationId: organization.id,
            startTime: startTime(),
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });

      it('accepts a start time slightly in the future and close to the 365-day limit', async () => {
        await enableRequestLogs([organization.id]);
        const row = usageRow({ organization_id: organization.id, created_at: minutesAgo(1) });
        await db.insert(microdollar_usage).values(row);

        await expect(listIds({ startTime: isoAt(Date.now() + MINUTE_MS) })).resolves.toEqual([
          row.id,
        ]);
        await expect(listIds({ startTime: isoAt(Date.now() - 364 * DAY_MS) })).resolves.toEqual([]);
      });
    });

    describe('userId', () => {
      it("returns only the given user's requests", async () => {
        await enableRequestLogs([organization.id]);
        const memberNewer = usageRow({
          organization_id: organization.id,
          kilo_user_id: member.id,
          created_at: minutesAgo(5),
        });
        const memberOlder = usageRow({
          organization_id: organization.id,
          kilo_user_id: member.id,
          created_at: minutesAgo(20),
        });
        const ownerRow = usageRow({
          organization_id: organization.id,
          kilo_user_id: owner.id,
          created_at: minutesAgo(10),
        });
        await db.insert(microdollar_usage).values([memberOlder, ownerRow, memberNewer]);

        await expect(listIds({ userId: member.id })).resolves.toEqual([
          memberNewer.id,
          memberOlder.id,
        ]);
        await expect(listIds({ userId: owner.id })).resolves.toEqual([ownerRow.id]);
      });

      it("does not return another organization's requests for the user", async () => {
        await enableRequestLogs([organization.id, otherOrganization.id]);
        await db
          .insert(microdollar_usage)
          .values([
            usageRow({ organization_id: otherOrganization.id, kilo_user_id: admin.id }),
            usageRow({ organization_id: organization.id, kilo_user_id: owner.id }),
          ]);

        await expect(listIds({ userId: admin.id })).resolves.toEqual([]);
      });

      it('rejects an empty user id with BAD_REQUEST', async () => {
        await enableRequestLogs([organization.id]);

        await expect(listIds({ userId: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });
    });

    describe('modelPrefix', () => {
      it('matches the requested model, falling back to the model when none was requested', async () => {
        await enableRequestLogs([organization.id]);
        const anthropic = usageRow({
          organization_id: organization.id,
          requested_model: 'anthropic/claude-sonnet-4.6',
          model: 'anthropic/claude-sonnet-4.6',
          created_at: minutesAgo(5),
        });
        const openAiFallback = usageRow({
          organization_id: organization.id,
          requested_model: null,
          model: 'openai/gpt-5',
          created_at: minutesAgo(10),
        });
        const auto = usageRow({
          organization_id: organization.id,
          requested_model: 'kilo-auto/balanced',
          model: 'moonshotai/kimi-k2',
          created_at: minutesAgo(15),
        });
        await db.insert(microdollar_usage).values([anthropic, openAiFallback, auto]);

        await expect(listIds({ modelPrefix: 'anthropic/' })).resolves.toEqual([anthropic.id]);
        await expect(listIds({ modelPrefix: 'openai/' })).resolves.toEqual([openAiFallback.id]);
        await expect(listIds({ modelPrefix: 'kilo-auto/' })).resolves.toEqual([auto.id]);
        await expect(listIds({ modelPrefix: 'moonshotai/' })).resolves.toEqual([]);
        await expect(listIds({ modelPrefix: 'anthropic/claude-sonnet-4.6' })).resolves.toEqual([
          anthropic.id,
        ]);
      });

      it('trims the prefix and treats a blank prefix as no filter', async () => {
        await enableRequestLogs([organization.id]);
        const anthropic = usageRow({
          organization_id: organization.id,
          requested_model: 'anthropic/claude-sonnet-4.6',
          created_at: minutesAgo(5),
        });
        const openAi = usageRow({
          organization_id: organization.id,
          requested_model: 'openai/gpt-5',
          created_at: minutesAgo(10),
        });
        await db.insert(microdollar_usage).values([anthropic, openAi]);

        await expect(listIds({ modelPrefix: '  anthropic/  ' })).resolves.toEqual([anthropic.id]);
        await expect(listIds({ modelPrefix: '   ' })).resolves.toEqual([anthropic.id, openAi.id]);
        await expect(listIds({ modelPrefix: '' })).resolves.toEqual([anthropic.id, openAi.id]);
      });

      it('matches LIKE wildcards and the escape character literally', async () => {
        await enableRequestLogs([organization.id]);
        const percent = usageRow({
          organization_id: organization.id,
          requested_model: 'a%b/model',
          created_at: minutesAgo(5),
        });
        const underscore = usageRow({
          organization_id: organization.id,
          requested_model: 'a_b/model',
          created_at: minutesAgo(10),
        });
        const backslash = usageRow({
          organization_id: organization.id,
          requested_model: 'a\\b/model',
          created_at: minutesAgo(15),
        });
        const plain = usageRow({
          organization_id: organization.id,
          requested_model: 'axb/model',
          created_at: minutesAgo(20),
        });
        await db.insert(microdollar_usage).values([percent, underscore, backslash, plain]);

        await expect(listIds({ modelPrefix: 'a%' })).resolves.toEqual([percent.id]);
        await expect(listIds({ modelPrefix: 'a_' })).resolves.toEqual([underscore.id]);
        await expect(listIds({ modelPrefix: 'a\\' })).resolves.toEqual([backslash.id]);
        await expect(listIds({ modelPrefix: '%' })).resolves.toEqual([]);
        await expect(listIds({ modelPrefix: '_' })).resolves.toEqual([]);
        await expect(listIds({ modelPrefix: 'a' })).resolves.toEqual([
          percent.id,
          underscore.id,
          backslash.id,
          plain.id,
        ]);
      });

      it('matches case-sensitively', async () => {
        await enableRequestLogs([organization.id]);
        const anthropic = usageRow({
          organization_id: organization.id,
          requested_model: 'anthropic/claude-sonnet-4.6',
        });
        await db.insert(microdollar_usage).values(anthropic);

        await expect(listIds({ modelPrefix: 'Anthropic/' })).resolves.toEqual([]);
        await expect(listIds({ modelPrefix: 'anthropic/' })).resolves.toEqual([anthropic.id]);
      });

      it('accepts a 200-character prefix and rejects a longer one with BAD_REQUEST', async () => {
        await enableRequestLogs([organization.id]);
        const longModel = 'x'.repeat(200);
        const row = usageRow({
          organization_id: organization.id,
          requested_model: `${longModel}/model`,
        });
        await db.insert(microdollar_usage).values(row);

        await expect(listIds({ modelPrefix: longModel })).resolves.toEqual([row.id]);
        await expect(listIds({ modelPrefix: `${longModel}x` })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      });
    });

    it('combines the start time, user, and model prefix filters', async () => {
      await enableRequestLogs([organization.id]);
      const start = Date.now() - 2 * HOUR_MS;
      const match = usageRow({
        organization_id: organization.id,
        kilo_user_id: member.id,
        requested_model: 'openai/gpt-5',
        created_at: isoAt(start - 10 * MINUTE_MS),
      });
      const wrongUser = usageRow({
        organization_id: organization.id,
        kilo_user_id: owner.id,
        requested_model: 'openai/gpt-5',
        created_at: isoAt(start - 10 * MINUTE_MS),
      });
      const wrongModel = usageRow({
        organization_id: organization.id,
        kilo_user_id: member.id,
        requested_model: 'anthropic/claude-sonnet-4.6',
        created_at: isoAt(start - 10 * MINUTE_MS),
      });
      const outsideWindow = usageRow({
        organization_id: organization.id,
        kilo_user_id: member.id,
        requested_model: 'openai/gpt-5',
        created_at: minutesAgo(5),
      });
      const otherOrgMatch = usageRow({
        organization_id: otherOrganization.id,
        kilo_user_id: member.id,
        requested_model: 'openai/gpt-5',
        created_at: isoAt(start - 10 * MINUTE_MS),
      });
      await db
        .insert(microdollar_usage)
        .values([match, wrongUser, wrongModel, outsideWindow, otherOrgMatch]);

      await expect(
        listIds({ startTime: isoAt(start), userId: member.id, modelPrefix: 'openai/' })
      ).resolves.toEqual([match.id]);
    });

    it(`returns at most ${REQUEST_LOGS_LIMIT} filtered requests, newest first`, async () => {
      await enableRequestLogs([organization.id]);
      const matching = Array.from({ length: REQUEST_LOGS_LIMIT + 1 }, (_, index) =>
        usageRow({
          organization_id: organization.id,
          requested_model: 'openai/gpt-5',
          created_at: isoAt(Date.now() - (index + 1) * 10_000),
        })
      );
      const newerNonMatching = Array.from({ length: 5 }, (_, index) =>
        usageRow({
          organization_id: organization.id,
          requested_model: 'anthropic/claude-sonnet-4.6',
          created_at: isoAt(Date.now() - (index + 1) * 1_000),
        })
      );
      await db.insert(microdollar_usage).values([...matching, ...newerNonMatching]);

      await expect(listIds({ modelPrefix: 'openai/' })).resolves.toEqual(
        matching.slice(0, REQUEST_LOGS_LIMIT).map(row => row.id)
      );
    });
  });

  describe('listEnkryptUsage', () => {
    it('rejects the request when the feature is not enabled for the organization', async () => {
      await enableRequestLogs([otherOrganization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.listEnkryptUsage({ organizationId: organization.id })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects a plain member with UNAUTHORIZED', async () => {
      await enableRequestLogs([organization.id]);
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.requestLogs.listEnkryptUsage({ organizationId: organization.id })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });
    });

    it('returns an empty list without usage', async () => {
      await enableRequestLogs([organization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.requestLogs.listEnkryptUsage({ organizationId: organization.id })
      ).resolves.toEqual([]);
    });

    it("returns the organization's guardrail calls from the last 24 hours, newest first", async () => {
      await enableRequestLogs([organization.id, otherOrganization.id]);
      const lookups = await enkryptLookups();
      const tooOldAt = hoursAgo(25);
      const partitions = await provisionEnkryptUsagePartitions(db, new Date(tooOldAt));
      expect(partitions.errors).toEqual([]);

      const errored = enkryptRow(lookups, {
        organization_id: organization.id,
        api_kind_id: lookups.apiKind.responses,
        decision_id: lookups.decision.error,
        guardrail_id: lookups.guardrail.input,
        enkrypt_credits_cost: null,
        charged_microdollars: 0,
        added_latency_ms: null,
        created_at: hoursAgo(0.5),
      });
      const blocked = enkryptRow(lookups, {
        organization_id: organization.id,
        kilo_user_id: member.id,
        session_id: 'ses_enkrypt_blocked',
        api_kind_id: lookups.apiKind.messages,
        decision_id: lookups.decision.blocked,
        guardrail_id: lookups.guardrail.output,
        enkrypt_credits_cost: 2,
        charged_microdollars: 200,
        added_latency_ms: 60,
        created_at: hoursAgo(1),
      });
      const allowed = enkryptRow(lookups, {
        organization_id: organization.id,
        api_kind_id: lookups.apiKind.chat_completions,
        decision_id: lookups.decision.allowed,
        enkrypt_credits_cost: 1.5,
        charged_microdollars: 150,
        added_latency_ms: 40,
        created_at: hoursAgo(23),
      });
      const tooOld = enkryptRow(lookups, {
        organization_id: organization.id,
        decision_id: lookups.decision.blocked,
        charged_microdollars: 9_000,
        added_latency_ms: 9_000,
        created_at: tooOldAt,
      });
      const otherOrgRow = enkryptRow(lookups, {
        organization_id: otherOrganization.id,
        decision_id: lookups.decision.blocked,
        charged_microdollars: 7_000,
        added_latency_ms: 7_000,
        created_at: hoursAgo(1),
      });
      await db.insert(enkrypt_usage).values([allowed, tooOld, errored, otherOrgRow, blocked]);

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.requestLogs.listEnkryptUsage({
        organizationId: organization.id,
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([
        {
          id: errored.id,
          created_at: errored.created_at,
          user: { id: owner.id, name: owner.google_user_name, email: owner.google_user_email },
          session_id: null,
          api_kind: 'responses',
          decision: 'error',
          guardrail: 'input',
          charged_microdollars: 0,
          added_latency_ms: null,
        },
        {
          id: blocked.id,
          created_at: blocked.created_at,
          user: { id: member.id, name: member.google_user_name, email: member.google_user_email },
          session_id: 'ses_enkrypt_blocked',
          api_kind: 'messages',
          decision: 'blocked',
          guardrail: 'output',
          charged_microdollars: 200,
          added_latency_ms: 60,
        },
        {
          id: allowed.id,
          created_at: allowed.created_at,
          user: { id: owner.id, name: owner.google_user_name, email: owner.google_user_email },
          session_id: null,
          api_kind: 'chat_completions',
          decision: 'allowed',
          guardrail: 'input',
          charged_microdollars: 150,
          added_latency_ms: 40,
        },
      ]);
      for (const row of result) {
        expect(row).not.toHaveProperty('enkrypt_credits_cost');
      }
    });

    it(`returns at most ${REQUEST_LOGS_LIMIT} calls, newest first`, async () => {
      await enableRequestLogs([organization.id]);
      const lookups = await enkryptLookups();
      const rows = Array.from({ length: REQUEST_LOGS_LIMIT + 1 }, (_, index) =>
        enkryptRow(lookups, {
          organization_id: organization.id,
          created_at: isoAt(Date.now() - (index + 1) * MINUTE_MS),
        })
      );
      await db.insert(enkrypt_usage).values(rows);

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.requestLogs.listEnkryptUsage({
        organizationId: organization.id,
      });

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
          usageId: otherOrgRow.id,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns a request older than 24 hours', async () => {
      await enableRequestLogs([organization.id]);
      const oldRow = usageRow({
        organization_id: organization.id,
        created_at: hoursAgo(3 * 24),
        model: 'openai/gpt-5',
        requested_model: 'openai/gpt-5',
      });
      await db.insert(microdollar_usage).values(oldRow);

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.requestLogs.getDetails({
        organizationId: organization.id,
        usageId: oldRow.id,
      });

      expect(result.request).toMatchObject({
        model: 'openai/gpt-5',
        requested_model: 'openai/gpt-5',
        auto_model: null,
      });
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
        requested_model: 'moonshotai/kimi-k2',
        cache_write_tokens: 42,
      });
      await db.insert(microdollar_usage).values(usage);
      await db.insert(microdollar_usage_metadata).values(
        metadataRow(usage.id, {
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
        usageId: usage.id,
      });

      expect(result).toEqual({
        request: {
          model: 'moonshotai/kimi-k2',
          requested_model: 'moonshotai/kimi-k2',
          provider: 'openrouter',
          inference_provider: 'deepinfra',
          cache_write_tokens: 42,
          status_code: 200,
          finish_reason: 'stop',
          api_kind: 'chat_completions',
          streamed: true,
          auto_model: null,
          session_id: 'ses_request_logs_test',
          editor_name: null,
          mode: null,
          inference_region: null,
        },
        metadata: { status: 'not-configured' },
      });
    });

    it('returns the auto model of an auto request', async () => {
      await enableRequestLogs([organization.id]);
      const usage = usageRow({
        organization_id: organization.id,
        model: 'moonshotai/kimi-k2',
        requested_model: 'kilo-auto/balanced',
      });
      await db.insert(microdollar_usage).values(usage);
      await db
        .insert(microdollar_usage_metadata)
        .values(metadataRow(usage.id, { auto_model_id: await autoModelId('kilo-auto/balanced') }));

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.requestLogs.getDetails({
        organizationId: organization.id,
        usageId: usage.id,
      });

      expect(result.request).toMatchObject({
        model: 'moonshotai/kimi-k2',
        requested_model: 'kilo-auto/balanced',
        auto_model: 'kilo-auto/balanced',
      });
    });
  });
});
