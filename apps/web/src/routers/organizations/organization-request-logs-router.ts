import {
  api_kind,
  auto_model,
  editor_name,
  enkrypt_usage,
  enkrypt_usage_decision,
  enkrypt_usage_detector,
  enkrypt_usage_guardrail,
  feature,
  finish_reason,
  inference_region,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  mode,
} from '@kilocode/db/schema';
import type {
  EnkryptDetectorId,
  EnkryptGuardrailDecision,
  EnkryptGuardrailDirection,
} from '@kilocode/db/schema-types';
import { CLAUDE_BILLING_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { readAiProviderMetadata } from '@kilocode/web-shared/lib/r2/ai-provider-metadata-bucket';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import {
  ENKRYPT_USAGE_OUTCOMES,
  ENKRYPT_USAGE_WINDOW_HOURS,
  REQUEST_LOGS_LIMIT,
  REQUEST_LOGS_MODEL_PREFIX_MAX_LENGTH,
  REQUEST_LOGS_START_TIME_MAX_AGE_DAYS,
  REQUEST_LOGS_WINDOW_HOURS,
  isRequestLogStartTimeInBounds,
  type EnkryptUsageOutcome,
} from '@/lib/request-logs/filters';
import { microdollarUsageModelStartsWith } from '@/lib/request-logs/model-prefix';
import { formatRequestLogProvider } from '@/lib/request-logs/provider-label';
import {
  parseRoutingDetails,
  type RequestLogRoutingDetails,
} from '@/lib/request-logs/routing-details';
import { timedUsageQuery } from '@/lib/usage-query';

const LOG_SOURCE = 'request-logs';

const StartTimeSchema = z.iso
  .datetime({ offset: true })
  .refine(value => isRequestLogStartTimeInBounds(Date.parse(value), Date.now()), {
    message: `Start time must be within the past ${REQUEST_LOGS_START_TIME_MAX_AGE_DAYS} days and not in the future.`,
  });

const RequestLogsListInputSchema = OrganizationIdInputSchema.extend({
  startTime: StartTimeSchema.optional(),
  userId: z.string().min(1).max(256).optional(),
  modelPrefix: z.string().trim().max(REQUEST_LOGS_MODEL_PREFIX_MAX_LENGTH).optional(),
});

const EnkryptUsageListInputSchema = OrganizationIdInputSchema.extend({
  startTime: StartTimeSchema.optional(),
  userId: z.string().min(1).max(256).optional(),
  outcome: z.enum(ENKRYPT_USAGE_OUTCOMES).optional(),
  guardrail: z.enum(['input', 'output']).optional(),
});

export type RequestLogMetadata =
  | { status: 'available'; routing: RequestLogRoutingDetails }
  | { status: 'not-found' | 'not-configured' | 'unreadable' };

/** The table lists newest first, so the window covers the hour leading up to the start time. */
function withinRequestLogWindow(startTime: string | undefined) {
  const windowEnd = startTime === undefined ? sql`NOW()` : sql`${startTime}::timestamptz`;
  return and(
    lte(microdollar_usage.created_at, windowEnd),
    gt(
      microdollar_usage.created_at,
      sql`${windowEnd} - make_interval(hours => ${REQUEST_LOGS_WINDOW_HOURS})`
    )
  );
}

/** Rows recorded before the output guardrail existed have no guardrail and are input scans. */
const enkryptGuardrail = sql<EnkryptGuardrailDirection>`coalesce(${enkrypt_usage_guardrail.guardrail}, 'input')`;

/** Sorted by detector so the order is stable. An empty array when none fired. */
const firedDetectors = sql<EnkryptDetectorId[]>`array(
  select ${enkrypt_usage_detector.detector} from ${enkrypt_usage_detector}
  where ${enkrypt_usage_detector.detector_id} = any(${enkrypt_usage.fired_detector_ids})
  order by ${enkrypt_usage_detector.detector}
)`;

const hasFiredDetectors = sql`coalesce(cardinality(${enkrypt_usage.fired_detector_ids}), 0) > 0`;

function withinEnkryptUsageWindow(startTime: string | undefined) {
  const windowEnd = startTime === undefined ? sql`NOW()` : sql`${startTime}::timestamptz`;
  return and(
    lte(enkrypt_usage.created_at, windowEnd),
    gt(
      enkrypt_usage.created_at,
      sql`${windowEnd} - make_interval(hours => ${ENKRYPT_USAGE_WINDOW_HOURS})`
    )
  );
}

function enkryptOutcomeFilter(outcome: EnkryptUsageOutcome | undefined): SQL | undefined {
  switch (outcome) {
    case undefined:
      return undefined;
    case 'allowed':
      return and(eq(enkrypt_usage_decision.decision, 'allowed'), sql`not ${hasFiredDetectors}`);
    case 'flagged':
      return and(eq(enkrypt_usage_decision.decision, 'allowed'), hasFiredDetectors);
    case 'blocked':
    case 'error':
      return eq(enkrypt_usage_decision.decision, outcome);
  }
}

function enkryptOutcome(
  decision: EnkryptGuardrailDecision,
  detectors: EnkryptDetectorId[]
): EnkryptUsageOutcome {
  return decision === 'allowed' && detectors.length > 0 ? 'flagged' : decision;
}

/** Guardrail calls with their user and, when inference was recorded, the request's model. */
function selectEnkryptCalls(tx: typeof readDb, where: SQL | undefined) {
  return tx
    .select({
      id: enkrypt_usage.id,
      created_at: enkrypt_usage.created_at,
      kilo_user_id: enkrypt_usage.kilo_user_id,
      user_name: kilocode_users.google_user_name,
      user_email: kilocode_users.google_user_email,
      session_id: enkrypt_usage.session_id,
      request_id: enkrypt_usage.microdollar_usage_id,
      model: microdollar_usage.model,
      requested_model: microdollar_usage.requested_model,
      api_kind: api_kind.api_kind,
      decision: enkrypt_usage_decision.decision,
      fired_detectors: firedDetectors,
      guardrail: enkryptGuardrail,
      charged_microdollars: enkrypt_usage.charged_microdollars,
      added_latency_ms: enkrypt_usage.added_latency_ms,
    })
    .from(enkrypt_usage)
    .innerJoin(api_kind, eq(api_kind.api_kind_id, enkrypt_usage.api_kind_id))
    .innerJoin(
      enkrypt_usage_decision,
      eq(enkrypt_usage_decision.decision_id, enkrypt_usage.decision_id)
    )
    .leftJoin(
      enkrypt_usage_guardrail,
      eq(enkrypt_usage_guardrail.guardrail_id, enkrypt_usage.guardrail_id)
    )
    .leftJoin(kilocode_users, eq(kilocode_users.id, enkrypt_usage.kilo_user_id))
    .leftJoin(
      microdollar_usage,
      and(
        eq(microdollar_usage.id, enkrypt_usage.microdollar_usage_id),
        eq(microdollar_usage.organization_id, enkrypt_usage.organization_id)
      )
    )
    .where(where);
}

type EnkryptCallRow = Awaited<ReturnType<typeof selectEnkryptCalls>>[number];

function toEnkryptCall(row: EnkryptCallRow) {
  return {
    id: row.id,
    created_at: toIsoTimestamp(row.created_at),
    user: { id: row.kilo_user_id, name: row.user_name, email: row.user_email },
    session_id: row.session_id,
    request_id: row.request_id,
    model: row.requested_model ?? row.model,
    api_kind: row.api_kind,
    outcome: enkryptOutcome(row.decision, row.fired_detectors),
    fired_detectors: row.fired_detectors,
    guardrail: row.guardrail,
    charged_microdollars: row.charged_microdollars,
    added_latency_ms: row.added_latency_ms,
  };
}

function toIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

async function readRequestLogMetadata(usageId: string): Promise<RequestLogMetadata> {
  try {
    const object = await readAiProviderMetadata(usageId, LOG_SOURCE);
    if (object.status !== 'found') return { status: object.status };
    const routing = parseRoutingDetails(object.body);
    return routing ? { status: 'available', routing } : { status: 'unreadable' };
  } catch (error) {
    console.error(`[${LOG_SOURCE}] failed to read AI provider metadata`, {
      usageId,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    return { status: 'unreadable' };
  }
}

export const organizationRequestLogsRouter = createTRPCRouter({
  isAvailable: organizationBillingProcedure.query(() => ({ available: true })),

  list: organizationBillingProcedure.input(RequestLogsListInputSchema).query(async ({ input }) => {
    const rows = await timedUsageQuery(
      {
        db: readDb,
        route: 'organizations.requestLogs.list',
        queryLabel: 'org_latest_requests',
        scope: 'org',
        period: `${REQUEST_LOGS_WINDOW_HOURS}h`,
      },
      tx =>
        tx
          .select({
            id: microdollar_usage.id,
            created_at: microdollar_usage.created_at,
            kilo_user_id: microdollar_usage.kilo_user_id,
            user_name: kilocode_users.google_user_name,
            user_email: kilocode_users.google_user_email,
            model: microdollar_usage.model,
            requested_model: microdollar_usage.requested_model,
            provider: microdollar_usage.provider,
            inference_provider: microdollar_usage.inference_provider,
            cost: microdollar_usage.cost,
            input_tokens: microdollar_usage.input_tokens,
            output_tokens: microdollar_usage.output_tokens,
            cache_hit_tokens: microdollar_usage.cache_hit_tokens,
            is_user_byok: microdollar_usage_metadata.is_user_byok,
            has_error: microdollar_usage.has_error,
            project_id: microdollar_usage.project_id,
            feature: feature.feature,
            latency: microdollar_usage_metadata.latency,
            generation_time: microdollar_usage_metadata.generation_time,
          })
          .from(microdollar_usage)
          .leftJoin(
            microdollar_usage_metadata,
            eq(microdollar_usage_metadata.id, microdollar_usage.id)
          )
          .leftJoin(feature, eq(feature.feature_id, microdollar_usage_metadata.feature_id))
          .leftJoin(kilocode_users, eq(kilocode_users.id, microdollar_usage.kilo_user_id))
          .where(
            and(
              eq(microdollar_usage.organization_id, input.organizationId),
              withinRequestLogWindow(input.startTime),
              input.userId === undefined
                ? undefined
                : eq(microdollar_usage.kilo_user_id, input.userId),
              input.modelPrefix ? microdollarUsageModelStartsWith(input.modelPrefix) : undefined
            )
          )
          .orderBy(desc(microdollar_usage.created_at))
          .limit(REQUEST_LOGS_LIMIT)
    );

    return rows.map(row => ({
      id: row.id,
      created_at: toIsoTimestamp(row.created_at),
      user: { id: row.kilo_user_id, name: row.user_name, email: row.user_email },
      model: row.requested_model ?? row.model,
      provider: formatRequestLogProvider(row.inference_provider),
      cost_microdollars: row.cost,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_hit_tokens: row.cache_hit_tokens,
      is_user_byok:
        row.provider === OPENAI_CHATGPT_PROVIDER_ID ||
        row.provider === CLAUDE_BILLING_PROVIDER_ID ||
        row.is_user_byok,
      has_error: row.has_error,
      project_id: row.project_id,
      feature: row.feature,
      latency_ms: row.latency,
      generation_time_ms: row.generation_time,
    }));
  }),

  listEnkryptUsage: organizationBillingProcedure
    .input(EnkryptUsageListInputSchema)
    .query(async ({ input }) => {
      const rows = await timedUsageQuery(
        {
          db: readDb,
          route: 'organizations.requestLogs.listEnkryptUsage',
          queryLabel: 'org_latest_enkrypt_usage',
          scope: 'org',
          period: `${ENKRYPT_USAGE_WINDOW_HOURS}h`,
        },
        tx =>
          selectEnkryptCalls(
            tx,
            and(
              eq(enkrypt_usage.organization_id, input.organizationId),
              withinEnkryptUsageWindow(input.startTime),
              input.userId === undefined ? undefined : eq(enkrypt_usage.kilo_user_id, input.userId),
              enkryptOutcomeFilter(input.outcome),
              input.guardrail === undefined ? undefined : eq(enkryptGuardrail, input.guardrail)
            )
          )
            .orderBy(desc(enkrypt_usage.created_at))
            .limit(REQUEST_LOGS_LIMIT)
      );
      return rows.map(toEnkryptCall);
    }),

  /** The request behind Enkrypt calls, which may have no inference usage when the guardrail blocked it. */
  getEnkryptRequestDetails: organizationBillingProcedure
    .input(OrganizationIdInputSchema.extend({ requestId: z.uuid() }))
    .query(async ({ input }) => {
      const calls = await selectEnkryptCalls(
        readDb,
        and(
          eq(enkrypt_usage.organization_id, input.organizationId),
          eq(enkrypt_usage.microdollar_usage_id, input.requestId)
        )
      ).orderBy(asc(enkrypt_usage.created_at));
      if (calls.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found.' });
      }

      const [request] = await readDb
        .select({
          model: microdollar_usage.model,
          requested_model: microdollar_usage.requested_model,
          inference_provider: microdollar_usage.inference_provider,
          cost: microdollar_usage.cost,
        })
        .from(microdollar_usage)
        .where(
          and(
            eq(microdollar_usage.id, input.requestId),
            eq(microdollar_usage.organization_id, input.organizationId)
          )
        )
        .limit(1);

      return {
        calls: calls.map(toEnkryptCall),
        inference: request
          ? {
              model: request.model,
              requested_model: request.requested_model,
              provider: formatRequestLogProvider(request.inference_provider),
              cost_microdollars: request.cost,
            }
          : null,
        metadata: await readRequestLogMetadata(input.requestId),
      };
    }),

  getDetails: organizationBillingProcedure
    .input(OrganizationIdInputSchema.extend({ usageId: z.uuid() }))
    .query(async ({ input }) => {
      const [request] = await readDb
        .select({
          model: microdollar_usage.model,
          requested_model: microdollar_usage.requested_model,
          provider: microdollar_usage.provider,
          inference_provider: microdollar_usage.inference_provider,
          cache_write_tokens: microdollar_usage.cache_write_tokens,
          status_code: microdollar_usage_metadata.status_code,
          finish_reason: finish_reason.finish_reason,
          api_kind: api_kind.api_kind,
          streamed: microdollar_usage_metadata.streamed,
          auto_model: auto_model.auto_model,
          session_id: microdollar_usage_metadata.session_id,
          editor_name: editor_name.editor_name,
          mode: mode.mode,
          inference_region: inference_region.inference_region,
        })
        .from(microdollar_usage)
        .leftJoin(
          microdollar_usage_metadata,
          eq(microdollar_usage_metadata.id, microdollar_usage.id)
        )
        .leftJoin(
          finish_reason,
          eq(finish_reason.finish_reason_id, microdollar_usage_metadata.finish_reason_id)
        )
        .leftJoin(api_kind, eq(api_kind.api_kind_id, microdollar_usage_metadata.api_kind_id))
        .leftJoin(
          editor_name,
          eq(editor_name.editor_name_id, microdollar_usage_metadata.editor_name_id)
        )
        .leftJoin(mode, eq(mode.mode_id, microdollar_usage_metadata.mode_id))
        .leftJoin(
          inference_region,
          eq(inference_region.inference_region_id, microdollar_usage_metadata.inference_region_id)
        )
        .leftJoin(
          auto_model,
          eq(auto_model.auto_model_id, microdollar_usage_metadata.auto_model_id)
        )
        .where(
          and(
            eq(microdollar_usage.id, input.usageId),
            eq(microdollar_usage.organization_id, input.organizationId)
          )
        )
        .limit(1);
      if (!request) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found.' });
      }

      return {
        request,
        metadata: await readRequestLogMetadata(input.usageId),
      };
    }),
});
