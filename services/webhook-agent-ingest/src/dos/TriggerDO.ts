import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, inArray, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import migrations from '../../drizzle/migrations';
import {
  requests as requestsTable,
  triggerConfig as triggerConfigTable,
} from '../db/sqlite-schema';
import type { ProcessStatus, RequestUpdates, RequestRow } from '../db/types';
import { logger } from '../util/logger';
import {
  MAX_INFLIGHT_REQUESTS,
  MAX_PAYLOAD_SIZE,
  MAX_REQUESTS,
  clampRequestLimit,
} from '../util/constants';
import { enqueueWebhookDelivery, type WebhookDeliveryMessage } from '../util/queue';
import {
  compareWebhookSecret,
  hashWebhookSecret,
  normalizeAuthHeader,
  sanitizeWebhookAuth,
  type StoredWebhookAuth,
  type WebhookAuthInput,
} from '../util/webhook-auth';
import { redactSensitiveHeaders } from '@kilocode/worker-utils/redact-headers';
import { computeNextCronTime } from '../util/cron';

export type { ProcessStatus, RequestUpdates } from '../db/types';

export const TriggerConfig = z.object({
  triggerId: z.string(),
  namespace: z.string(),
  userId: z.string().nullable(),
  orgId: z.string().nullable(),
  createdAt: z.string(),
  isActive: z.boolean(),
  targetType: z.enum(['cloud_agent', 'kiloclaw_chat']).default('cloud_agent'),
  kiloclawInstanceId: z.string().nullable().optional(),
  githubRepo: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  promptTemplate: z.string(),
  profileId: z.string().nullable().optional(),
  autoCommit: z.boolean().optional(),
  condenseOnComplete: z.boolean().optional(),
  webhookAuthHeader: z.string().optional(),
  webhookAuthSecretHash: z.string().optional(),
  activationMode: z.enum(['webhook', 'scheduled']).default('webhook'),
  cronExpression: z.string().nullable().optional(),
  cronTimezone: z.string().nullable().optional().default('UTC'),
  lastScheduledAt: z.string().nullable().optional(),
  nextScheduledAt: z.string().nullable().optional(),
});

export type TriggerConfig = z.infer<typeof TriggerConfig>;

export type TriggerConfigResponse = Omit<TriggerConfig, 'webhookAuthSecretHash'> & {
  webhookAuthConfigured: boolean;
};

export type CapturedRequest = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  queryString: string | null;
  headers: Record<string, string>;
  body: string;
  contentType: string | null;
  sourceIp: string | null;
  startedAt: string | null;
  completedAt: string | null;
  processStatus: ProcessStatus;
  cloudAgentSessionId: string | null;
  errorMessage: string | null;
  triggerSource: string;
};

type ConfigureInput = {
  targetType?: 'cloud_agent' | 'kiloclaw_chat';
  kiloclawInstanceId?: string;
  githubRepo?: string;
  mode?: string;
  model?: string;
  promptTemplate: string;
  profileId?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  webhookAuth?: WebhookAuthInput;
  activationMode?: 'webhook' | 'scheduled';
  cronExpression?: string;
  cronTimezone?: string;
};

type WebhookAuthUpdateInput = {
  header?: string | null;
  secret?: string | null;
};

type UpdateConfigInput = {
  mode?: string;
  model?: string;
  promptTemplate?: string;
  isActive?: boolean;
  profileId?: string;
  autoCommit?: boolean | null;
  condenseOnComplete?: boolean | null;
  webhookAuth?: WebhookAuthUpdateInput;
  cronExpression?: string;
  cronTimezone?: string;
};

export class TriggerDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  async configure(
    namespace: string,
    triggerId: string,
    configOverrides?: ConfigureInput
  ): Promise<{ success: boolean }> {
    const { userId, orgId } = parseNamespace(namespace);

    if (!configOverrides) {
      throw new Error('Trigger configuration is required');
    }

    const webhookAuth = await this.resolveWebhookAuthOnCreate(configOverrides.webhookAuth);

    const config: TriggerConfig = {
      triggerId,
      namespace,
      userId,
      orgId,
      createdAt: new Date().toISOString(),
      isActive: true,
      targetType: configOverrides.targetType ?? 'cloud_agent',
      kiloclawInstanceId: configOverrides.kiloclawInstanceId ?? null,
      githubRepo: configOverrides.githubRepo ?? null,
      mode: configOverrides.mode ?? null,
      model: configOverrides.model ?? null,
      promptTemplate: configOverrides.promptTemplate,
      profileId: configOverrides.profileId ?? null,
      autoCommit: configOverrides.autoCommit,
      condenseOnComplete: configOverrides.condenseOnComplete,
      webhookAuthHeader: webhookAuth?.header,
      webhookAuthSecretHash: webhookAuth?.secretHash,
      activationMode: configOverrides.activationMode ?? 'webhook',
      cronExpression: configOverrides.cronExpression ?? null,
      cronTimezone: configOverrides.cronTimezone ?? 'UTC',
    };

    await this.ctx.storage.put('config', config);

    const insertValues = {
      trigger_id: config.triggerId,
      namespace: config.namespace,
      user_id: config.userId,
      org_id: config.orgId,
      created_at: config.createdAt,
      is_active: config.isActive ? 1 : 0,
      target_type: config.targetType,
      kiloclaw_instance_id: config.kiloclawInstanceId ?? null,
      github_repo: config.githubRepo ?? null,
      mode: config.mode ?? null,
      model: config.model ?? null,
      prompt_template: config.promptTemplate,
      profile_id: config.profileId ?? null,
      auto_commit: config.autoCommit !== undefined ? (config.autoCommit ? 1 : 0) : null,
      condense_on_complete:
        config.condenseOnComplete !== undefined ? (config.condenseOnComplete ? 1 : 0) : null,
      webhook_auth_header: webhookAuth?.header ?? null,
      webhook_auth_secret_hash: webhookAuth?.secretHash ?? null,
      activation_mode: config.activationMode,
      cron_expression: config.cronExpression ?? null,
      cron_timezone: config.cronTimezone ?? 'UTC',
    };

    // On conflict, update all fields except the PK and created_at (preserve original creation time)
    const { trigger_id: _pk, created_at: _ca, ...updateValues } = insertValues;

    this.db
      .insert(triggerConfigTable)
      .values(insertValues)
      .onConflictDoUpdate({
        target: triggerConfigTable.trigger_id,
        set: updateValues,
      })
      .run();

    // Set initial alarm for scheduled triggers
    if (config.activationMode === 'scheduled' && config.cronExpression) {
      await this.scheduleNextAlarm(config);
    }

    logger.info('Trigger configured', {
      triggerId,
      namespace,
      userId,
      orgId,
      profileId: config.profileId,
      activationMode: config.activationMode,
    });

    return { success: true };
  }

  async isActive(): Promise<boolean> {
    const config = await this.getConfig();
    return config?.isActive ?? false;
  }

  async getConfig(): Promise<TriggerConfig | null> {
    const rows = this.db.select().from(triggerConfigTable).limit(1).all();

    if (rows.length === 0) {
      return null;
    }

    const record = rows[0];
    return {
      triggerId: record.trigger_id,
      namespace: record.namespace,
      userId: record.user_id,
      orgId: record.org_id,
      createdAt: record.created_at,
      isActive: record.is_active === 1,
      targetType: record.target_type === 'kiloclaw_chat' ? 'kiloclaw_chat' : 'cloud_agent',
      kiloclawInstanceId: record.kiloclaw_instance_id ?? null,
      githubRepo: record.github_repo ?? null,
      mode: record.mode ?? null,
      model: record.model ?? null,
      promptTemplate: record.prompt_template,
      profileId: record.profile_id ?? null,
      autoCommit: record.auto_commit !== null ? record.auto_commit === 1 : undefined,
      condenseOnComplete:
        record.condense_on_complete !== null ? record.condense_on_complete === 1 : undefined,
      webhookAuthHeader: record.webhook_auth_header ?? undefined,
      webhookAuthSecretHash: record.webhook_auth_secret_hash ?? undefined,
      activationMode: record.activation_mode === 'scheduled' ? 'scheduled' : 'webhook',
      cronExpression: record.cron_expression ?? null,
      cronTimezone: record.cron_timezone ?? 'UTC',
      lastScheduledAt: record.last_scheduled_at ?? null,
      nextScheduledAt: record.next_scheduled_at ?? null,
    };
  }

  async getConfigForResponse(): Promise<TriggerConfigResponse | null> {
    const config = await this.getConfig();
    return this.sanitizeConfigForResponse(config);
  }

  /**
   * Update trigger config with partial updates.
   * Note: githubRepo and triggerId cannot be changed after creation.
   *
   * For optional fields (autoCommit, condenseOnComplete):
   * - undefined = leave unchanged
   * - null = explicitly clear the field
   * - value = set to new value
   */
  async updateConfig(updates: UpdateConfigInput): Promise<{ success: boolean }> {
    const existingConfig = await this.getConfig();
    if (!existingConfig) {
      return { success: false };
    }

    const resolveNullable = <T>(
      update: T | null | undefined,
      existing: T | undefined
    ): T | undefined => {
      if (update === null) return undefined;
      if (update === undefined) return existing;
      return update;
    };

    const webhookAuth = await this.resolveWebhookAuthOnUpdate(existingConfig, updates.webhookAuth);

    const updatedConfig: TriggerConfig = {
      ...existingConfig,
      mode: updates.mode ?? existingConfig.mode,
      model: updates.model ?? existingConfig.model,
      promptTemplate: updates.promptTemplate ?? existingConfig.promptTemplate,
      isActive: updates.isActive ?? existingConfig.isActive,
      profileId: updates.profileId ?? existingConfig.profileId,
      autoCommit: resolveNullable(updates.autoCommit, existingConfig.autoCommit),
      condenseOnComplete: resolveNullable(
        updates.condenseOnComplete,
        existingConfig.condenseOnComplete
      ),
      webhookAuthHeader: webhookAuth?.header,
      webhookAuthSecretHash: webhookAuth?.secretHash,
      cronExpression: updates.cronExpression ?? existingConfig.cronExpression,
      cronTimezone: updates.cronTimezone ?? existingConfig.cronTimezone,
    };

    await this.ctx.storage.put('config', updatedConfig);

    this.db
      .update(triggerConfigTable)
      .set({
        mode: updatedConfig.mode,
        model: updatedConfig.model,
        prompt_template: updatedConfig.promptTemplate,
        is_active: updatedConfig.isActive ? 1 : 0,
        profile_id: updatedConfig.profileId,
        auto_commit:
          updatedConfig.autoCommit !== undefined ? (updatedConfig.autoCommit ? 1 : 0) : null,
        condense_on_complete:
          updatedConfig.condenseOnComplete !== undefined
            ? updatedConfig.condenseOnComplete
              ? 1
              : 0
            : null,
        webhook_auth_header: webhookAuth?.header ?? null,
        webhook_auth_secret_hash: webhookAuth?.secretHash ?? null,
        cron_expression: updatedConfig.cronExpression ?? null,
        cron_timezone: updatedConfig.cronTimezone ?? 'UTC',
      })
      .where(eq(triggerConfigTable.trigger_id, updatedConfig.triggerId))
      .run();

    // Alarm lifecycle for scheduled triggers
    if (updatedConfig.activationMode === 'scheduled') {
      if (!updatedConfig.isActive) {
        // Deactivated — clear alarm, retry flag, and stale next-run display
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete('alarmRetry');
        updatedConfig.nextScheduledAt = null;
        this.db
          .update(triggerConfigTable)
          .set({ next_scheduled_at: null })
          .where(eq(triggerConfigTable.trigger_id, updatedConfig.triggerId))
          .run();
        await this.ctx.storage.put('config', updatedConfig);
      } else if (
        updates.isActive === true ||
        updates.cronExpression !== undefined ||
        updates.cronTimezone !== undefined
      ) {
        // Reactivated or cron expression changed — reschedule
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete('alarmRetry');
        await this.scheduleNextAlarm(updatedConfig);
      }
    }

    logger.info('Trigger config updated', {
      triggerId: updatedConfig.triggerId,
      namespace: updatedConfig.namespace,
      profileId: updatedConfig.profileId,
    });

    return { success: true };
  }

  async getAuthConfig(): Promise<StoredWebhookAuth | null> {
    const config = await this.getConfig();
    return extractStoredWebhookAuth(config);
  }

  private async resolveWebhookAuthOnCreate(
    input?: WebhookAuthInput
  ): Promise<StoredWebhookAuth | null> {
    if (!input) {
      return null;
    }

    const header = normalizeAuthHeader(input.header);
    const secret = input.secret?.trim();

    if (!header) {
      throw new Error('Webhook auth header cannot be empty');
    }

    if (!secret) {
      throw new Error('Webhook auth secret cannot be empty');
    }

    const secretHash = await hashWebhookSecret(secret);
    return { header, secretHash };
  }

  private async resolveWebhookAuthOnUpdate(
    existing: TriggerConfig,
    input?: WebhookAuthUpdateInput
  ): Promise<StoredWebhookAuth | null> {
    const current = extractStoredWebhookAuth(existing);

    if (!input) {
      return current;
    }

    if (input.header === null || input.secret === null) {
      return null;
    }

    let header = current?.header ?? null;
    if (input.header !== undefined) {
      const normalized = normalizeAuthHeader(input.header);
      if (!normalized) {
        throw new Error('Webhook auth header cannot be empty');
      }
      header = normalized;
    }

    let secretHash = current?.secretHash ?? null;
    if (input.secret !== undefined) {
      const trimmedSecret = input.secret?.trim();
      if (!trimmedSecret) {
        throw new Error('Webhook auth secret cannot be empty');
      }
      secretHash = await hashWebhookSecret(trimmedSecret);
    }

    if (!header && !secretHash) {
      return null;
    }

    if (!header || !secretHash) {
      throw new Error('Webhook auth requires both header and secret');
    }

    return { header, secretHash };
  }

  private sanitizeConfigForResponse(config: TriggerConfig | null): TriggerConfigResponse | null {
    if (!config) {
      return null;
    }

    const { webhookAuthSecretHash: _webhookAuthSecretHash, ...rest } = config;
    const webhookAuth = sanitizeWebhookAuth(extractStoredWebhookAuth(config));

    return {
      ...rest,
      webhookAuthHeader: webhookAuth.webhookAuthHeader,
      webhookAuthConfigured: webhookAuth.webhookAuthConfigured,
    };
  }

  async captureRequest(request: {
    method: string;
    path: string;
    queryString: string | null;
    headers: Record<string, string>;
    body: string;
    contentType: string | null;
    sourceIp: string | null;
  }): Promise<{ success: true; requestId: string } | { success: false; error: string }> {
    const config = await this.getConfig();
    if (!config?.isActive) {
      return { success: false, error: 'Trigger not configured or inactive' };
    }

    const storedWebhookAuth = extractStoredWebhookAuth(config);
    if (storedWebhookAuth) {
      const candidateSecret =
        request.headers[storedWebhookAuth.header] ??
        request.headers[storedWebhookAuth.header.toLowerCase()];
      if (!candidateSecret) {
        logger.warn('Webhook auth header missing', {
          triggerId: config.triggerId,
          namespace: config.namespace,
        });
        return { success: false, error: 'Unauthorized' };
      }

      const isMatch = await compareWebhookSecret(storedWebhookAuth.secretHash, candidateSecret);
      if (!isMatch) {
        logger.warn('Webhook auth secret mismatch', {
          triggerId: config.triggerId,
          namespace: config.namespace,
        });
        return { success: false, error: 'Unauthorized' };
      }
    }

    const inflightRows = this.db
      .select({ count: sql<number>`count(*)` })
      .from(requestsTable)
      .where(inArray(requestsTable.process_status, ['captured', 'inprogress']))
      .all();
    const inflightCount = inflightRows[0]?.count ?? 0;
    if (inflightCount >= MAX_INFLIGHT_REQUESTS) {
      return { success: false, error: 'Too many in-flight requests' };
    }

    if (request.body.length > MAX_PAYLOAD_SIZE) {
      return { success: false, error: 'Payload too large' };
    }

    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    this.db
      .insert(requestsTable)
      .values({
        id: requestId,
        timestamp,
        method: request.method,
        path: request.path,
        query_string: request.queryString,
        headers: JSON.stringify(
          redactSensitiveHeaders(
            request.headers,
            storedWebhookAuth ? [storedWebhookAuth.header] : undefined
          )
        ),
        body: request.body,
        content_type: request.contentType,
        source_ip: request.sourceIp,
        process_status: 'captured',
      })
      .run();

    // Delete overflow rows, preserving in-progress requests
    this.db.run(sql`
      DELETE FROM ${requestsTable}
      WHERE ${requestsTable.id} IN (
        SELECT ${requestsTable.id} FROM ${requestsTable}
        WHERE ${requestsTable.process_status} NOT IN ('inprogress')
        ORDER BY ${requestsTable.created_at} DESC
        LIMIT -1 OFFSET ${MAX_REQUESTS}
      )
    `);

    const message: WebhookDeliveryMessage = {
      namespace: config.namespace,
      triggerId: config.triggerId,
      requestId,
    };

    try {
      await enqueueWebhookDelivery(this.env.WEBHOOK_DELIVERY_QUEUE, message);
    } catch (enqueueError) {
      logger.error('Failed to enqueue webhook delivery, marking request as failed', {
        requestId,
        error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
      });

      this.db
        .update(requestsTable)
        .set({
          process_status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: `Queue enqueue failed: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
        })
        .where(eq(requestsTable.id, requestId))
        .run();

      return { success: false, error: 'Failed to queue request for processing' };
    }

    logger.info('Request captured', {
      requestId,
      method: request.method,
      path: request.path,
      contentType: request.contentType,
    });

    return { success: true, requestId };
  }

  async listRequests(limit: number = 50): Promise<{ requests: CapturedRequest[] }> {
    const clampedLimit = clampRequestLimit(limit);
    const rows = this.db
      .select()
      .from(requestsTable)
      .orderBy(desc(requestsTable.timestamp))
      .limit(clampedLimit)
      .all();

    const capturedRequests = rows.map(recordToCapturedRequest);

    return { requests: capturedRequests };
  }

  async getRequest(requestId: string): Promise<CapturedRequest | null> {
    const rows = this.db.select().from(requestsTable).where(eq(requestsTable.id, requestId)).all();

    if (rows.length === 0) {
      return null;
    }

    return recordToCapturedRequest(rows[0]);
  }

  async updateRequest(requestId: string, updates: RequestUpdates): Promise<{ success: boolean }> {
    const setValues: Partial<typeof requestsTable.$inferInsert> = {};
    if (updates.process_status !== undefined) setValues.process_status = updates.process_status;
    if (updates.cloud_agent_session_id !== undefined)
      setValues.cloud_agent_session_id = updates.cloud_agent_session_id;
    if (updates.started_at !== undefined) setValues.started_at = updates.started_at;
    if (updates.completed_at !== undefined) setValues.completed_at = updates.completed_at;
    if (updates.error_message !== undefined) setValues.error_message = updates.error_message;

    if (Object.keys(setValues).length === 0) {
      return { success: true };
    }

    this.db.update(requestsTable).set(setValues).where(eq(requestsTable.id, requestId)).run();

    logger.info('Request updated', {
      requestId,
      updates,
    });

    return { success: true };
  }

  async alarm(): Promise<void> {
    const config = await this.getConfig();
    if (!config || !config.isActive || config.activationMode !== 'scheduled') {
      return; // Deactivated or mode changed — don't reschedule
    }

    // If this is a DST retry alarm (no cron occurrence matched), just try to reschedule
    // without creating a request. The flag is cleared by scheduleNextAlarm on success.
    const isRetry = (await this.ctx.storage.get<boolean>('alarmRetry')) ?? false;
    if (isRetry) {
      await this.ctx.storage.delete('alarmRetry');
      await this.scheduleNextAlarm(config);
      return;
    }

    // Check in-flight limit (same as webhook path)
    const inflightRows = this.db
      .select({ count: sql<number>`count(*)` })
      .from(requestsTable)
      .where(inArray(requestsTable.process_status, ['captured', 'inprogress']))
      .all();
    const inflightCount = inflightRows[0]?.count ?? 0;

    if (inflightCount >= MAX_INFLIGHT_REQUESTS) {
      logger.warn('Scheduled run skipped: too many in-flight', {
        triggerId: config.triggerId,
      });
      await this.scheduleNextAlarm(config); // Still reschedule
      return;
    }

    // Create synthetic request
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    this.db
      .insert(requestsTable)
      .values({
        id: requestId,
        timestamp,
        method: 'SCHEDULED',
        path: '/',
        query_string: null,
        headers: '{}',
        body: '{}',
        content_type: null,
        source_ip: null,
        process_status: 'captured',
        trigger_source: 'scheduled',
      })
      .run();

    // Overflow cleanup (same as captureRequest)
    this.db.run(sql`
      DELETE FROM ${requestsTable}
      WHERE ${requestsTable.id} IN (
        SELECT ${requestsTable.id} FROM ${requestsTable}
        WHERE ${requestsTable.process_status} NOT IN ('inprogress')
        ORDER BY ${requestsTable.created_at} DESC
        LIMIT -1 OFFSET ${MAX_REQUESTS}
      )
    `);

    // Enqueue to existing delivery queue
    try {
      await enqueueWebhookDelivery(this.env.WEBHOOK_DELIVERY_QUEUE, {
        namespace: config.namespace,
        triggerId: config.triggerId,
        requestId,
      });
    } catch (enqueueError) {
      logger.error('Failed to enqueue scheduled delivery, marking request as failed', {
        requestId,
        error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
      });

      this.db
        .update(requestsTable)
        .set({
          process_status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: `Queue enqueue failed: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
        })
        .where(eq(requestsTable.id, requestId))
        .run();
    }

    // Update last_scheduled_at — use updated config for scheduleNextAlarm
    const updatedConfig = { ...config, lastScheduledAt: timestamp };
    this.db
      .update(triggerConfigTable)
      .set({ last_scheduled_at: timestamp })
      .where(eq(triggerConfigTable.trigger_id, config.triggerId))
      .run();
    await this.ctx.storage.put('config', updatedConfig);

    logger.info('Scheduled trigger fired', {
      triggerId: config.triggerId,
      requestId,
    });

    // Reschedule next run
    await this.scheduleNextAlarm(updatedConfig);
  }

  private async scheduleNextAlarm(config: TriggerConfig): Promise<void> {
    if (!config.cronExpression || config.activationMode !== 'scheduled') return;

    const nextTime = computeNextCronTime(config.cronExpression, config.cronTimezone ?? 'UTC');
    if (!nextTime) {
      // DST spring-forward can skip an occurrence. Schedule a retry in 1 hour
      // so the trigger doesn't stop forever. Set a flag so alarm() knows this
      // is a reschedule retry, not a real cron fire.
      logger.error('Failed to compute next cron time, retrying in 1 hour', {
        triggerId: config.triggerId,
      });
      await this.ctx.storage.put('alarmRetry', true);
      await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
      return;
    }

    // Successfully computed next time — clear any stale retry flag so it doesn't
    // cause alarm() to skip the next real cron fire.
    await this.ctx.storage.delete('alarmRetry');

    // Add jitter to prevent thundering herd on popular cron times (±30s)
    const jitterMs = Math.floor(Math.random() * 60_000) - 30_000;
    const alarmTime = Math.max(nextTime.getTime() + jitterMs, Date.now() + 60_000);
    await this.ctx.storage.setAlarm(alarmTime);

    // Persist for UI display (use original cron time, not jittered time)
    const nextScheduledAt = nextTime.toISOString();
    this.db
      .update(triggerConfigTable)
      .set({ next_scheduled_at: nextScheduledAt })
      .where(eq(triggerConfigTable.trigger_id, config.triggerId))
      .run();
    await this.ctx.storage.put('config', { ...config, nextScheduledAt });
  }

  async deleteTrigger(): Promise<{ success: boolean }> {
    await this.ctx.storage.deleteAll();

    // Re-run migrations so the schema is present if this instance receives further requests
    // before Cloudflare evicts it (deleteAll wipes the __drizzle_migrations tracking table too)
    await migrate(this.db, migrations);

    logger.info('Trigger deleted');

    return { success: true };
  }
}

function parseNamespace(namespace: string): { userId: string | null; orgId: string | null } {
  if (namespace.startsWith('user/')) {
    return {
      userId: namespace.slice(5),
      orgId: null,
    };
  }
  if (namespace.startsWith('org/')) {
    return {
      userId: null,
      orgId: namespace.slice(4),
    };
  }
  return {
    userId: namespace,
    orgId: null,
  };
}

function extractStoredWebhookAuth(config: TriggerConfig | null): StoredWebhookAuth | null {
  if (!config?.webhookAuthHeader || !config.webhookAuthSecretHash) {
    return null;
  }
  return {
    header: config.webhookAuthHeader,
    secretHash: config.webhookAuthSecretHash,
  };
}

function recordToCapturedRequest(record: RequestRow): CapturedRequest {
  const headers = parseRequestHeaders(record.headers);
  return {
    id: record.id,
    timestamp: record.timestamp,
    method: record.method,
    path: record.path,
    queryString: record.query_string,
    headers,
    body: record.body,
    contentType: record.content_type,
    sourceIp: record.source_ip,
    startedAt: record.started_at,
    completedAt: record.completed_at,
    processStatus: record.process_status,
    cloudAgentSessionId: record.cloud_agent_session_id,
    errorMessage: record.error_message,
    triggerSource: record.trigger_source,
  };
}

function parseRequestHeaders(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const headers: Record<string, string> = {};
      for (const [key, headerValue] of Object.entries(parsed)) {
        if (typeof headerValue === 'string') {
          headers[key] = headerValue;
        }
      }
      return headers;
    }
  } catch {
    return {};
  }
  return {};
}
