import { and, eq } from 'drizzle-orm';
import {
  cliSessions,
  cli_sessions_v2,
  kilocode_users,
  kilo_pass_subscriptions,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  microdollar_usage,
  microdollar_usage_metadata,
  user_auth_provider,
  user_deletion_audit_events,
  user_deletion_requests,
  user_deletion_steps,
  type User,
} from '@kilocode/db/schema';
import {
  KiloPassCadence,
  KiloPassTier,
  UserDeletionAuditEventType as Audit,
  UserDeletionCloudSubjectResolution as Resolution,
  UserDeletionRequestStatus as RequestStatus,
  UserDeletionStepKey as Step,
  UserDeletionStepStatus as StepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { sendAccountDeletionCompletedEmail } from '@/lib/email';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { findUserById } from '@/lib/user';
import { USER_DELETION_ID_ONLY_CATALOG_VERSION } from '@/lib/user/deletion-queue/deletion-constants';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import { enqueueHistoricalUserDeletion } from '@/lib/user/deletion-queue/deletion-legacy-backfill';
import { retryAttentionTask } from '@/lib/user/deletion-queue/deletion-outcomes';
import { claimNextTaskForRequest } from '@/lib/user/deletion-queue/deletion-task-selector';
import { runClaimedDeletionTask } from '@/lib/user/deletion-queue/deletion-task-runner';
import { insertTestUser, insertTestUserAndGoogleAuth } from '@/tests/helpers/user.helper';

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/config.server'),
  INTERNAL_API_SECRET: 'backfill-test-secret',
  KILOCLAW_API_URL: 'https://claw.test',
  SESSION_INGEST_WORKER_URL: 'https://ingest.test',
  USER_DELETION_AUDIT_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
  USER_DELETION_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
}));
jest.mock('@/lib/r2/cli-sessions', () => ({ deleteBlobs: jest.fn(async () => undefined) }));
jest.mock('@/lib/ai-gateway/abuse-service', () => ({
  reportEvents: jest.fn(async () => undefined),
}));
jest.mock('@/lib/email', () => ({ sendAccountDeletionCompletedEmail: jest.fn() }));

const code = 'user_id_only_backfill_2026_08_26';
const userIdSteps = [
  Step.KiloclawDestroy,
  Step.CliV1Blobs,
  Step.CliV2Sessions,
  Step.UsagePromptPrefixes,
  Step.Posthog,
  Step.Anonymize,
];
const historicalUser = (id = 'oauth/GitHub/CaseSensitive+42') =>
  insertTestUserAndGoogleAuth({
    id,
    google_user_email: `deleted+${id}@deleted.invalid`,
    blocked_reason: 'soft-deleted at 2026-08-11T23:59:59.999Z',
    api_token_pepper: 'previous-api-pepper',
    web_session_pepper: 'previous-web-pepper',
  });

async function queueState() {
  return {
    requests: await db.select().from(user_deletion_requests),
    steps: await db.select().from(user_deletion_steps),
    audits: await db.select().from(user_deletion_audit_events),
  };
}

describe('historical GDPR user-ID backfill', () => {
  let admin: User;
  let user: User;
  const enqueue = (overrides: Partial<Parameters<typeof enqueueHistoricalUserDeletion>[0]> = {}) =>
    enqueueHistoricalUserDeletion({
      userId: user.id,
      adminUserId: admin.id,
      execute: true,
      ...overrides,
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', {
      ...process.env,
      POSTHOG_PERSONAL_API_KEY: 'backfill-test-posthog-key',
      POSTHOG_ENVIRONMENT_ID: 'backfill-test',
      POSTHOG_HOST: 'https://posthog.test',
    });
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    await cleanupDbForTest();
    admin = await insertTestUser({ is_admin: true });
    user = await historicalUser();
  });
  afterEach(() => jest.restoreAllMocks());

  it('validates by default without writing queue records or changing the user', async () => {
    await expect(
      enqueueHistoricalUserDeletion({ userId: user.id, adminUserId: admin.id })
    ).resolves.toEqual({ status: 'eligible' });
    expect(await queueState()).toEqual({ requests: [], steps: [], audits: [] });
    expect(await findUserById(user.id)).toEqual(user);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['2026-08-12T00:00:00.000Z', '2026-08-26T00:00:00.000Z'])(
    'accepts soft-deleted users without a date cutoff: %s',
    async timestamp => {
      await db
        .update(kilocode_users)
        .set({ blocked_reason: `soft-deleted at ${timestamp}` })
        .where(eq(kilocode_users.id, user.id));
      const before = await findUserById(user.id);
      expect(await enqueue({ execute: false })).toEqual({ status: 'eligible' });
      expect(await queueState()).toEqual({ requests: [], steps: [], audits: [] });
      expect(await enqueue()).toMatchObject({ status: 'enqueued' });
      expect(await findUserById(user.id)).toEqual(before);
    }
  );

  it.each<[Partial<User>, string]>([
    [{ blocked_reason: null }, 'not_canonical_soft_deleted_user'],
    [{ google_user_email: 'current@example.com' }, 'not_canonical_soft_deleted_user'],
    [{ blocked_reason: 'manual block' }, 'not_canonical_soft_deleted_user'],
    [{ blocked_reason: 'soft-deleted at invalid' }, 'invalid_deletion_timestamp'],
    [{ blocked_reason: 'soft-deleted at 2026-08-11' }, 'invalid_deletion_timestamp'],
    [{ is_bot: true }, 'protected_bot'],
  ])('refuses unsafe historical identity %j', async (overrides, refusalCode) => {
    await db.update(kilocode_users).set(overrides).where(eq(kilocode_users.id, user.id));
    const before = await findUserById(user.id);
    expect(await enqueue()).toEqual({ status: 'refused', code: refusalCode });
    expect(await queueState()).toEqual({ requests: [], steps: [], audits: [] });
    expect(await findUserById(user.id)).toEqual(before);
  });

  it.each([{ is_admin: false }, { blocked_reason: 'blocked' }])(
    'requires an active administrator: %j',
    async overrides => {
      await db.update(kilocode_users).set(overrides).where(eq(kilocode_users.id, admin.id));
      expect(await enqueue()).toEqual({ status: 'refused', code: 'active_admin_required' });
      expect(await queueState()).toEqual({ requests: [], steps: [], audits: [] });
    }
  );

  it('refuses missing users and missing administrators', async () => {
    expect(await enqueue({ userId: 'missing' })).toEqual({
      status: 'refused',
      code: 'user_not_found',
    });
    expect(await enqueue({ adminUserId: 'missing' })).toEqual({
      status: 'refused',
      code: 'active_admin_required',
    });
    expect(await queueState()).toEqual({ requests: [], steps: [], audits: [] });
  });

  it.each(['pass', 'active', 'past_due', 'unpaid', 'trialing'] as const)(
    'refuses live %s subscriptions in both modes',
    async status => {
      if (status === 'pass') {
        await db.insert(kilo_pass_subscriptions).values({
          kilo_user_id: user.id,
          provider_subscription_id: 'sub_backfill',
          stripe_subscription_id: 'sub_backfill',
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          status: 'active',
          cancel_at_period_end: false,
        });
      } else {
        await db
          .insert(kiloclaw_subscriptions)
          .values({ user_id: user.id, plan: 'standard', status, cancel_at_period_end: true });
      }
      for (const execute of [false, true]) {
        expect(await enqueue({ execute })).toEqual({
          status: 'refused',
          code: 'live_subscription',
        });
      }
      expect(await queueState()).toEqual({ requests: [], steps: [], audits: [] });
      expect(await findUserById(user.id)).toEqual(user);
    }
  );

  it.each(['user', 'email'])('refuses a conflicting active request matched by %s', async match => {
    const [active] = await db
      .insert(user_deletion_requests)
      .values({
        user_id: match === 'user' ? user.id : null,
        target_email: user.google_user_email,
        target_email_hmac: hmacDeletionEmail(
          match === 'email' ? user.google_user_email.toLowerCase() : 'original@example.com'
        ),
        cloud_subject_resolution:
          match === 'user' ? Resolution.CurrentUser : Resolution.AuthoritativeAbsence,
      })
      .returning();
    expect(await enqueue()).toEqual({
      status: 'refused',
      code: 'active_deletion_request',
      requestId: active.id,
    });
    expect(await queueState()).toEqual({ requests: [active], steps: [], audits: [] });
  });

  it('bootstraps exactly once across concurrent and repeated imports without reblocking the user', async () => {
    const results = await Promise.all([enqueue(), enqueue()]);
    expect(results.map(result => result.status).sort()).toEqual(['enqueued', 'existing']);
    const state = await queueState();
    expect(state.requests).toHaveLength(1);
    const [request] = state.requests;
    for (const result of results) expect(result).toMatchObject({ requestId: request.id });
    expect(request).toMatchObject({
      user_id: user.id,
      target_email: user.google_user_email,
      status: RequestStatus.InProgress,
      catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION,
      cloud_subject_resolution: Resolution.CurrentUser,
      requested_by_kilo_user_id: admin.id,
      pylon_ticket_ref: null,
    });
    expect(state.steps).toHaveLength(6);
    const pending = state.steps.filter(step => step.status === StepStatus.Pending);
    expect(pending.map(step => step.step_key).sort()).toEqual([...userIdSteps].sort());
    expect(state.audits).toEqual([
      expect.objectContaining({
        event_type: Audit.RequestCreated,
        actor_kilo_user_id: admin.id,
        details_json: { catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION, code },
      }),
    ]);
    expect(await enqueue()).toEqual({
      status: 'existing',
      requestId: request.id,
      requestStatus: RequestStatus.InProgress,
    });
    expect(await queueState()).toEqual(state);
    expect(await findUserById(user.id)).toEqual(user);
  });

  it.each(['matched', 'absent'] as const)(
    'runs all six real tasks with %s PostHog identity without notifications and retains an exact, case-sensitive completion receipt',
    async posthogMatch => {
      await db.insert(user_deletion_requests).values({
        status: RequestStatus.Completed,
        completed_at: new Date().toISOString(),
        target_email_hmac: hmacDeletionEmail(user.google_user_email.toLowerCase()),
        cloud_subject_resolution: Resolution.AuthoritativeAbsence,
        catalog_version: 1,
      });
      await db.insert(kiloclaw_instances).values({ user_id: user.id, sandbox_id: 'backfill-test' });
      await db.insert(cliSessions).values({
        kilo_user_id: user.id,
        title: 'Historical session',
        created_on_platform: 'cli',
        api_conversation_history_blob_url: 'sessions/test/api_conversation_history.json',
      });
      const sessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      await db
        .insert(cli_sessions_v2)
        .values({ session_id: sessionId, kilo_user_id: user.id, created_on_platform: 'cli' });
      const [usage] = await db
        .insert(microdollar_usage)
        .values({
          kilo_user_id: user.id,
          cost: 17,
          input_tokens: 1,
          output_tokens: 1,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
        })
        .returning();
      await db.insert(microdollar_usage_metadata).values({
        id: usage.id,
        message_id: 'backfill-message',
        user_prompt_prefix: 'private user prompt',
      });
      jest.spyOn(KiloClawInternalClient.prototype, 'destroy').mockResolvedValue({ ok: true });
      const posthogBase = 'https://posthog.test/api/environments/backfill-test';
      const posthogLookupUrl = `${posthogBase}/persons/?distinct_id=${encodeURIComponent(user.id)}`;
      const posthogStatusUrl = `${posthogBase}/persons/deletion_status/?person_uuid=posthog-person&status=all`;
      jest.mocked(fetch).mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === `https://ingest.test/api/session/${sessionId}`) {
          expect(method).toBe('DELETE');
          await db
            .delete(cli_sessions_v2)
            .where(
              and(
                eq(cli_sessions_v2.kilo_user_id, user.id),
                eq(cli_sessions_v2.session_id, sessionId)
              )
            );
          return new Response(null, { status: 204 });
        }
        if (url === posthogLookupUrl) {
          expect(method).toBe('GET');
          return Response.json({
            results:
              posthogMatch === 'matched'
                ? [
                    {
                      uuid: 'posthog-person',
                      distinct_ids: [user.id],
                      properties: { email: 'former@example.com' },
                    },
                  ]
                : [],
          });
        }
        if (posthogMatch === 'matched') {
          if (url === `${posthogBase}/persons/bulk_delete/`) {
            expect(method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toEqual({
              ids: ['posthog-person'],
              delete_events: true,
              delete_recordings: true,
              keep_person: false,
            });
            return Response.json(
              {
                id: 'posthog-backfill-deletion',
                persons_found: 1,
                persons_deleted: 1,
                events_queued_for_deletion: true,
                recordings_queued_for_deletion: true,
                deletion_errors: [],
              },
              { status: 202 }
            );
          }
          if (url === `${posthogBase}/persons/posthog-person/`) {
            expect(method).toBe('GET');
            return new Response(null, { status: 404 });
          }
          if (url === posthogStatusUrl) {
            expect(method).toBe('GET');
            const completedAt = new Date().toISOString();
            return Response.json({
              results: [
                {
                  person_uuid: 'posthog-person',
                  status: 'completed',
                  created_at: completedAt,
                  delete_verified_at: completedAt,
                },
              ],
            });
          }
        }
        throw new Error('Unexpected external request');
      });
      const result = await enqueue();
      if (result.status !== 'enqueued') throw new Error(`Expected enqueued, got ${result.status}`);
      const requestId = result.requestId;
      expect(
        await retryAttentionTask({
          requestId,
          stepKey: Step.Customerio,
          actorKiloUserId: admin.id,
          reason: 'retry excluded task',
        })
      ).toBe(false);
      const claimOptions = { requestId, remainingMs: 60_000, leaseMs: 60_000 };
      expect(
        await claimNextTaskForRequest({
          ...claimOptions,
          excludeStepKeys: userIdSteps.slice(0, -1),
        })
      ).toBeNull();
      for (const stepKey of userIdSteps) {
        if (stepKey === Step.Posthog) {
          const pendingState = await queueState();
          expect(pendingState.requests.find(request => request.id === requestId)).toMatchObject({
            status: RequestStatus.InProgress,
            anonymized_at: null,
          });
          expect(
            pendingState.steps
              .filter(step => step.status === StepStatus.Pending)
              .map(step => step.step_key)
              .sort()
          ).toEqual([Step.Posthog, Step.Anonymize].sort());
          expect(
            await claimNextTaskForRequest({ ...claimOptions, excludeStepKeys: [Step.Posthog] })
          ).toBeNull();
        }
        const claim = await claimNextTaskForRequest(claimOptions);
        expect(claim?.step.step_key).toBe(stepKey);
        if (!claim) throw new Error('Expected a claimed task');
        const outcome = await runClaimedDeletionTask({
          stepId: claim.step.id,
          claimToken: claim.claimToken,
          deadlineAt: Date.now() + 60_000,
        });
        expect(outcome).toMatchObject({
          kind: 'applied',
          effectiveOutcome: {
            kind:
              stepKey === Step.Posthog && posthogMatch === 'absent'
                ? 'not_applicable'
                : 'succeeded',
          },
        });
      }
      const state = await queueState();
      const receipt = state.requests.find(request => request.id === requestId);
      expect(receipt).toMatchObject({
        status: RequestStatus.Completed,
        catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION,
        user_id: null,
        target_email: null,
        anonymized_at: expect.any(String),
        completed_at: expect.any(String),
      });
      const statuses = new Map(state.steps.map(step => [step.step_key, step.status]));
      expect([...statuses.keys()].sort()).toEqual([...userIdSteps].sort());
      for (const stepKey of userIdSteps) {
        expect(statuses.get(stepKey)).toBe(
          stepKey === Step.Posthog && posthogMatch === 'absent'
            ? StepStatus.NotApplicable
            : StepStatus.Succeeded
        );
      }
      expect(await db.select().from(cliSessions)).toEqual([]);
      expect(await db.select().from(cli_sessions_v2)).toEqual([]);
      expect(await db.select().from(user_auth_provider)).toEqual([]);
      const [instance] = await db.select().from(kiloclaw_instances);
      expect(instance).toMatchObject({ user_id: user.id, destroyed_at: expect.any(String) });
      const [metadata] = await db.select().from(microdollar_usage_metadata);
      expect(metadata).toMatchObject({ id: usage.id, user_prompt_prefix: null });
      expect(await db.select().from(microdollar_usage)).toEqual([usage]);
      expect(await findUserById(user.id)).toMatchObject({
        blocked_reason: user.blocked_reason,
        google_user_name: 'Deleted User',
        stripe_customer_id: user.stripe_customer_id,
      });
      expect(sendAccountDeletionCompletedEmail).not.toHaveBeenCalled();
      expect(jest.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
        `https://ingest.test/api/session/${sessionId}`,
        posthogLookupUrl,
        ...(posthogMatch === 'matched'
          ? [
              `${posthogBase}/persons/bulk_delete/`,
              `${posthogBase}/persons/posthog-person/`,
              posthogStatusUrl,
            ]
          : []),
      ]);
      const existing = { status: 'existing', requestId, requestStatus: RequestStatus.Completed };
      expect(await enqueue()).toEqual(existing);
      expect(await queueState()).toEqual(state);
      const differentlyCased = await historicalUser(user.id.toLowerCase());
      expect(await enqueue({ userId: differentlyCased.id })).toMatchObject({ status: 'enqueued' });
      const [other] = await db
        .select()
        .from(user_deletion_requests)
        .where(eq(user_deletion_requests.user_id, differentlyCased.id));
      expect(other.target_email_hmac).toBe(receipt?.target_email_hmac);
      expect(other.cloud_subject_proof_ref).not.toBe(receipt?.cloud_subject_proof_ref);
      expect(await enqueue()).toEqual(existing);
    }
  );
});
