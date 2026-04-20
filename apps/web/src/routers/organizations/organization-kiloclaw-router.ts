import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import {
  ALL_SECRET_FIELD_KEYS,
  FIELD_KEY_TO_ENTRY,
  MAX_CUSTOM_SECRET_VALUE_LENGTH,
  validateFieldValue,
  getEntriesByCategory,
  isValidCustomSecretKey,
  isValidConfigPath,
} from '@kilocode/kiloclaw-secret-catalog';
import { KILOCLAW_API_URL } from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_version_pins,
  kiloclaw_image_catalog,
  kiloclaw_cli_runs,
} from '@kilocode/db/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import type { KiloClawDashboardStatus, KiloCodeConfigResponse } from '@/lib/kiloclaw/types';
import { cancelCliRun, createCliRun, getCliRunStatus } from '@/lib/kiloclaw/cli-runs';
import { queryDiskUsage } from '@/lib/kiloclaw/disk-usage';
import {
  cycleInboundEmailAddressForInstance,
  getInboundEmailAddressForInstance,
} from '@/lib/kiloclaw/inbound-email-alias';
import {
  getActiveOrgInstance,
  markActiveInstanceDestroyed,
  renameOrgInstance,
  restoreDestroyedInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { clearSubscriptionLifecycleAfterInstanceDestroy } from '@/lib/kiloclaw/instance-lifecycle';
import {
  getOrganizationProvisionLockKey,
  withKiloclawProvisionContextLock,
} from '@/lib/kiloclaw/provision-lock';
import {
  organizationMemberProcedure,
  organizationMemberMutationProcedure,
} from '@/routers/organizations/utils';

import PostHogClient from '@/lib/posthog';
import { CHANGELOG_ENTRIES } from '@/app/(app)/claw/components/changelog-data';

/** Error codes whose messages may contain raw internal details. */
const UNSAFE_ERROR_CODES = new Set(['config_read_failed', 'config_replace_failed']);

function getKiloClawApiErrorPayload(err: KiloClawApiError): { message?: string; code?: string } {
  if (!err.responseBody) return {};
  try {
    const parsed = JSON.parse(err.responseBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const code = 'code' in parsed && typeof parsed.code === 'string' ? parsed.code : undefined;
    const message =
      'error' in parsed && typeof parsed.error === 'string' && parsed.error.length > 0
        ? parsed.error
        : undefined;
    return {
      message: code && UNSAFE_ERROR_CODES.has(code) ? undefined : message,
      code,
    };
  } catch {
    return {};
  }
}

function handleFileOperationError(err: unknown, operation: string): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof KiloClawApiError && err.statusCode === 404) {
    const { code, message } = getKiloClawApiErrorPayload(err);
    throw new TRPCError({
      code: 'NOT_FOUND',
      message:
        code === 'controller_route_unavailable'
          ? `Instance needs redeploy to support ${operation}`
          : (message ?? `Failed to ${operation}`),
    });
  }
  if (err instanceof KiloClawApiError && err.statusCode === 400) {
    const { message, code } = getKiloClawApiErrorPayload(err);
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        code && UNSAFE_ERROR_CODES.has(code)
          ? `Failed to ${operation}`
          : (message ?? `Failed to ${operation}`),
    });
  }
  if (err instanceof KiloClawApiError && err.statusCode === 409) {
    const { message, code } = getKiloClawApiErrorPayload(err);
    throw new TRPCError({
      code: 'CONFLICT',
      message: message ?? 'File was modified externally',
      cause: code ? new UpstreamApiError(code) : undefined,
    });
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message:
      err instanceof KiloClawApiError
        ? (getKiloClawApiErrorPayload(err).message ?? `Failed to ${operation}`)
        : `Failed to ${operation}`,
  });
}

/**
 * Resolve the active org instance, throwing NOT_FOUND if none exists.
 */
async function requireOrgInstance(userId: string, orgId: string) {
  const instance = await getActiveOrgInstance(userId, orgId);
  if (!instance) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No active KiloClaw instance found for this organization',
    });
  }
  return instance;
}

// ── Input schemas ──────────────────────────────────────────────────

const kilocodeDefaultModelSchema = z
  .string()
  .regex(
    /^kilocode\/[^/]+\/.+$/,
    'kilocodeDefaultModel must start with kilocode/ and include a provider'
  );

function isValidUserTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const userTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidUserTimezone, 'userTimezone must be a valid IANA timezone');

const channelsSchema = z
  .object({
    telegramBotToken: z.string().optional(),
    discordBotToken: z.string().optional(),
    slackBotToken: z.string().optional(),
    slackAppToken: z.string().optional(),
  })
  .optional();

const updateConfigSchema = z.object({
  organizationId: z.uuid(),
  envVars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  channels: channelsSchema,
  kilocodeDefaultModel: kilocodeDefaultModelSchema.nullable().optional(),
  userTimezone: userTimezoneSchema.nullable().optional(),
});

const updateKiloCodeConfigSchema = z.object({
  organizationId: z.uuid(),
  kilocodeDefaultModel: kilocodeDefaultModelSchema.nullable().optional(),
});

const patchChannelsSchema = z.object({
  organizationId: z.uuid(),
  telegramBotToken: z.string().nullable().optional(),
  discordBotToken: z.string().nullable().optional(),
  slackBotToken: z.string().nullable().optional(),
  slackAppToken: z.string().nullable().optional(),
});

const patchBotIdentitySchema = z.object({
  organizationId: z.uuid(),
  botName: z.string().trim().min(1).max(80).nullable().optional(),
  botNature: z.string().trim().min(1).max(120).nullable().optional(),
  botVibe: z.string().trim().min(1).max(120).nullable().optional(),
  botEmoji: z.string().trim().min(1).max(16).nullable().optional(),
});

// ── Helpers ────────────────────────────────────────────────────────

function buildWorkerChannels(channels: z.infer<typeof updateConfigSchema>['channels']) {
  if (!channels) return undefined;
  return {
    telegramBotToken: channels.telegramBotToken
      ? encryptKiloClawSecret(channels.telegramBotToken)
      : undefined,
    discordBotToken: channels.discordBotToken
      ? encryptKiloClawSecret(channels.discordBotToken)
      : undefined,
    slackBotToken: channels.slackBotToken
      ? encryptKiloClawSecret(channels.slackBotToken)
      : undefined,
    slackAppToken: channels.slackAppToken
      ? encryptKiloClawSecret(channels.slackAppToken)
      : undefined,
  };
}

function buildWorkerChannelsPatch(
  channels: Omit<z.infer<typeof patchChannelsSchema>, 'organizationId'>
) {
  const result: Record<string, ReturnType<typeof encryptKiloClawSecret> | null | undefined> = {};
  for (const [key, value] of Object.entries(channels)) {
    if (value === undefined) continue;
    result[key] = value === null ? null : encryptKiloClawSecret(value);
  }
  return result;
}

type KiloCodeConfigPublicResponse = Pick<
  KiloCodeConfigResponse,
  'kilocodeApiKeyExpiresAt' | 'kilocodeDefaultModel'
>;

function sanitizeKiloCodeConfigResponse(
  response: KiloCodeConfigResponse
): KiloCodeConfigPublicResponse {
  return {
    kilocodeApiKeyExpiresAt: response.kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel: response.kilocodeDefaultModel,
  };
}

const logDiskUsageError = sentryLogger('organization-kiloclaw-disk-usage', 'error');

// ── Router ─────────────────────────────────────────────────────────

export const organizationKiloclawRouter = createTRPCRouter({
  // ── Global data (no instance needed) ──────────────────────────

  getChangelog: organizationMemberProcedure.query(async () => {
    return CHANGELOG_ENTRIES;
  }),

  serviceDegraded: organizationMemberProcedure.query(async () => {
    // Reuse the same status page check as personal
    try {
      const response = await fetch('https://status.kilo.ai/index.json', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const data = await response.json();
      const included: Array<{ id: string; type: string; attributes?: { status?: string } }> =
        data.included ?? [];
      const resource = included.find(
        entry => entry.type === 'status_page_resource' && entry.id === '8737418'
      );
      return resource?.attributes?.status != null && resource.attributes.status !== 'operational';
    } catch {
      return false;
    }
  }),

  latestVersion: organizationMemberProcedure.query(async () => {
    const client = new KiloClawInternalClient();
    return client.getLatestVersion();
  }),

  // ── Instance status ───────────────────────────────────────────

  getStatus: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
    const workerUrl = KILOCLAW_API_URL || 'https://claw.kilo.ai';

    // No org instance → return a "no instance" sentinel so the frontend
    // renders setup entry points. Without this guard, workerInstanceId(null)
    // → undefined → the worker queries the personal DO, leaking personal
    // instance status into the org context.
    if (!instance) {
      return {
        userId: ctx.user.id,
        sandboxId: null,
        provider: null,
        runtimeId: null,
        storageId: null,
        region: null,
        status: null,
        provisionedAt: null,
        lastStartedAt: null,
        lastStoppedAt: null,
        envVarCount: 0,
        secretCount: 0,
        channelCount: 0,
        flyAppName: null,
        flyMachineId: null,
        flyVolumeId: null,
        flyRegion: null,
        machineSize: null,
        openclawVersion: null,
        imageVariant: null,
        trackedImageTag: null,
        trackedImageDigest: null,
        googleConnected: false,
        gmailNotificationsEnabled: false,
        execSecurity: null,
        execAsk: null,
        botName: null,
        botNature: null,
        botVibe: null,
        botEmoji: null,
        workerUrl,
        name: null,
        instanceId: null,
        inboundEmailAddress: null,
        inboundEmailEnabled: false,
      } satisfies KiloClawDashboardStatus;
    }

    const client = new KiloClawInternalClient();
    const [status, inboundEmailAddress] = await Promise.all([
      client.getStatus(ctx.user.id, workerInstanceId(instance)),
      getInboundEmailAddressForInstance(instance.id),
    ]);

    return {
      ...status,
      name: instance.name ?? null,
      workerUrl,
      instanceId: instance.id,
      inboundEmailAddress,
      inboundEmailEnabled: instance.inboundEmailEnabled,
    } satisfies KiloClawDashboardStatus;
  }),

  getDiskUsage: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    try {
      return await queryDiskUsage(instance.sandboxId);
    } catch (error) {
      logDiskUsageError('Failed to fetch organization disk usage', {
        error,
        organizationId: input.organizationId,
        sandboxId: instance.sandboxId,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch disk usage',
        cause: error,
      });
    }
  }),

  renameInstance: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), name: z.string().min(1).max(50).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      try {
        await renameOrgInstance(instance.id, ctx.user.id, input.organizationId, input.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename instance';
        const code = message === 'No active instance found' ? 'NOT_FOUND' : 'BAD_REQUEST';
        throw new TRPCError({ code, message });
      }
    }),

  cycleInboundEmailAddress: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    return {
      inboundEmailAddress: await cycleInboundEmailAddressForInstance(instance.id),
    };
  }),

  // ── Lifecycle ─────────────────────────────────────────────────

  provision: organizationMemberMutationProcedure
    .input(updateConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return await withKiloclawProvisionContextLock(
        getOrganizationProvisionLockKey(ctx.user.id, input.organizationId),
        async () => {
          // TODO: org-specific kiloclaw billing gate — currently gated by
          // organizationMemberMutationProcedure (requireActiveSubscriptionOrTrial for org)
          const existing = await getActiveOrgInstance(ctx.user.id, input.organizationId);
          if (existing) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'You already have an active KiloClaw instance in this organization',
            });
          }

          const encryptedSecrets = input.secrets
            ? Object.fromEntries(
                Object.entries(input.secrets).map(([k, v]) => [k, encryptKiloClawSecret(v)])
              )
            : undefined;

          const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
          const kilocodeApiKey = generateApiToken(ctx.user, undefined, {
            expiresIn: expiresInSeconds,
          });
          const kilocodeApiKeyExpiresAt = new Date(
            Date.now() + expiresInSeconds * 1000
          ).toISOString();

          const client = new KiloClawInternalClient();
          const result = await client.provision(
            ctx.user.id,
            {
              envVars: input.envVars,
              encryptedSecrets,
              channels: buildWorkerChannels(input.channels),
              kilocodeApiKey,
              kilocodeApiKeyExpiresAt,
              kilocodeDefaultModel: input.kilocodeDefaultModel ?? undefined,
              userTimezone: input.userTimezone ?? undefined,
            },
            { orgId: input.organizationId }
          );

          PostHogClient().capture({
            distinctId: ctx.user.google_user_email,
            event: 'claw_org_instance_provisioned',
            properties: {
              user_id: ctx.user.id,
              organization_id: input.organizationId,
              instance_id: result.instanceId,
            },
          });

          return result;
        }
      );
    }),

  updateConfig: organizationMemberMutationProcedure
    .input(updateConfigSchema)
    .mutation(async ({ ctx, input }) => {
      // Re-provision: same as provision but expects existing instance
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);

      const encryptedSecrets = input.secrets
        ? Object.fromEntries(
            Object.entries(input.secrets).map(([k, v]) => [k, encryptKiloClawSecret(v)])
          )
        : undefined;

      const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
      const kilocodeApiKey = generateApiToken(ctx.user, undefined, {
        expiresIn: expiresInSeconds,
      });
      const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      const [pin] = await db
        .select({ image_tag: kiloclaw_version_pins.image_tag })
        .from(kiloclaw_version_pins)
        .where(eq(kiloclaw_version_pins.instance_id, instance.id))
        .limit(1);

      const client = new KiloClawInternalClient();
      return client.provision(
        ctx.user.id,
        {
          envVars: input.envVars,
          encryptedSecrets,
          channels: buildWorkerChannels(input.channels),
          kilocodeApiKey,
          kilocodeApiKeyExpiresAt,
          kilocodeDefaultModel: input.kilocodeDefaultModel ?? undefined,
          userTimezone: input.userTimezone ?? undefined,
          pinnedImageTag: pin?.image_tag,
        },
        { instanceId: instance.id, orgId: input.organizationId }
      );
    }),

  start: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    const result = await client.start(ctx.user.id, workerInstanceId(instance));
    PostHogClient().capture({
      distinctId: ctx.user.google_user_email,
      event: 'claw_org_instance_started',
      properties: { user_id: ctx.user.id, organization_id: input.organizationId },
    });
    return result;
  }),

  stop: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.stop(ctx.user.id, workerInstanceId(instance));
  }),

  destroy: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const destroyedRow = await markActiveInstanceDestroyed(ctx.user.id, instance.id);
    const client = new KiloClawInternalClient();
    let result: Awaited<ReturnType<KiloClawInternalClient['destroy']>>;
    try {
      result = await client.destroy(ctx.user.id, workerInstanceId(instance));
    } catch (error) {
      if (destroyedRow) {
        await restoreDestroyedInstance(destroyedRow.id);
      }
      throw error;
    }

    try {
      await clearSubscriptionLifecycleAfterInstanceDestroy({
        actorUserId: ctx.user.id,
        kiloUserId: ctx.user.id,
        instanceId: instance.id,
      });
    } catch (cleanupError) {
      console.error('[organization-kiloclaw] Post-destroy cleanup failed:', cleanupError);
    }

    return result;
  }),

  // ── Config ────────────────────────────────────────────────────

  patchConfig: organizationMemberMutationProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
      const kilocodeApiKey = generateApiToken(ctx.user, undefined, {
        expiresIn: expiresInSeconds,
      });
      const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      const response = await client.patchKiloCodeConfig(
        ctx.user.id,
        { ...input, kilocodeApiKey, kilocodeApiKeyExpiresAt },
        workerInstanceId(instance)
      );
      return sanitizeKiloCodeConfigResponse(response);
    }),

  updateKiloCodeConfig: organizationMemberMutationProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
      const kilocodeApiKey = generateApiToken(ctx.user, undefined, {
        expiresIn: expiresInSeconds,
      });
      const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      const response = await client.patchKiloCodeConfig(
        ctx.user.id,
        { ...input, kilocodeApiKey, kilocodeApiKeyExpiresAt },
        workerInstanceId(instance)
      );
      return sanitizeKiloCodeConfigResponse(response);
    }),

  patchChannels: organizationMemberMutationProcedure
    .input(patchChannelsSchema)
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const { organizationId: _, ...channelFields } = input;
      const client = new KiloClawInternalClient();
      return client.patchChannels(
        ctx.user.id,
        { channels: buildWorkerChannelsPatch(channelFields) },
        workerInstanceId(instance)
      );
    }),

  patchExecPreset: organizationMemberMutationProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        security: z.string().optional(),
        ask: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return client.patchExecPreset(ctx.user.id, input, workerInstanceId(instance));
    }),

  patchBotIdentity: organizationMemberMutationProcedure
    .input(patchBotIdentitySchema)
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return client.patchBotIdentity(ctx.user.id, input, workerInstanceId(instance));
    }),

  patchSecrets: organizationMemberMutationProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        secrets: z
          .record(z.string(), z.string().max(MAX_CUSTOM_SECRET_VALUE_LENGTH).nullable())
          .refine(
            obj =>
              Object.keys(obj).every(
                k => ALL_SECRET_FIELD_KEYS.has(k) || isValidCustomSecretKey(k)
              ),
            {
              message:
                'Invalid secret key: must be a catalog field key or valid env var name (A-Z, 0-9, _, no KILOCLAW_ prefix)',
            }
          ),
        meta: z
          .record(
            z.string(),
            z.object({
              configPath: z
                .string()
                .refine(isValidConfigPath, {
                  message:
                    'Not a supported credential path. See https://docs.openclaw.ai/reference/secretref-credential-surface',
                })
                .optional(),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value === null) continue;
        if (ALL_SECRET_FIELD_KEYS.has(key)) {
          const entry = FIELD_KEY_TO_ENTRY.get(key);
          const field = entry?.fields.find(f => f.key === key);
          if (field?.maxLength != null && value.length > field.maxLength) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `${field.label} exceeds maximum length of ${field.maxLength} characters`,
            });
          }
          if (!validateFieldValue(value, field?.validationPattern)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: field?.validationMessage ?? `Invalid value for ${key}`,
            });
          }
        }
      }

      const encryptedPatch: Record<string, ReturnType<typeof encryptKiloClawSecret> | null> = {};
      for (const [key, value] of Object.entries(input.secrets)) {
        encryptedPatch[key] = value === null ? null : encryptKiloClawSecret(value);
      }

      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      try {
        return await client.patchSecrets(
          ctx.user.id,
          { secrets: encryptedPatch, meta: input.meta },
          workerInstanceId(instance)
        );
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode >= 400 && err.statusCode < 500) {
          let message = `Secret patch failed (${err.statusCode})`;
          try {
            const parsed = JSON.parse(err.responseBody);
            if (typeof parsed.error === 'string') message = parsed.error;
            else if (typeof parsed.message === 'string') message = parsed.message;
          } catch {
            if (err.responseBody) message = err.responseBody;
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw err;
      }
    }),

  getConfig: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const token = generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
    const client = new KiloClawUserClient(token);
    return client.getConfig({ userId: ctx.user.id, instanceId: workerInstanceId(instance) });
  }),

  getChannelCatalog: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const token = generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
    const client = new KiloClawUserClient(token);
    const config = await client.getConfig({
      userId: ctx.user.id,
      instanceId: workerInstanceId(instance),
    });
    const channels = getEntriesByCategory('channel');
    return channels.map(entry => ({
      id: entry.id,
      label: entry.label,
      configured: config.configuredSecrets[entry.id] ?? false,
      fields: entry.fields.map(f => ({
        key: f.key,
        label: f.label,
        placeholder: f.placeholder,
        placeholderConfigured: f.placeholderConfigured,
        validationPattern: f.validationPattern,
        validationMessage: f.validationMessage,
      })),
      helpText: entry.helpText,
      helpUrl: entry.helpUrl,
      guideText: entry.guideText,
      guideUrl: entry.guideUrl,
      allFieldsRequired: entry.allFieldsRequired ?? false,
    }));
  }),

  getSecretCatalog: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const token = generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
    const client = new KiloClawUserClient(token);
    const config = await client.getConfig({
      userId: ctx.user.id,
      instanceId: workerInstanceId(instance),
    });
    const tools = getEntriesByCategory('tool');
    return tools.map(entry => ({
      id: entry.id,
      label: entry.label,
      configured: config.configuredSecrets[entry.id] ?? false,
      fields: entry.fields.map(f => ({
        key: f.key,
        label: f.label,
        placeholder: f.placeholder,
        placeholderConfigured: f.placeholderConfigured,
        validationPattern: f.validationPattern,
        validationMessage: f.validationMessage,
      })),
      helpText: entry.helpText,
      helpUrl: entry.helpUrl,
      guideText: entry.guideText,
      guideUrl: entry.guideUrl,
      allFieldsRequired: entry.allFieldsRequired ?? false,
    }));
  }),

  // ── Machine operations ────────────────────────────────────────

  restartMachine: organizationMemberMutationProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        imageTag: z
          .string()
          .max(128)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const token = generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
      const client = new KiloClawUserClient(token);
      return client.restartMachine(input.imageTag ? { imageTag: input.imageTag } : undefined, {
        userId: ctx.user.id,
        instanceId: workerInstanceId(instance),
      });
    }),

  restartOpenClaw: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.restartGatewayProcess(ctx.user.id, workerInstanceId(instance));
  }),

  runDoctor: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.runDoctor(ctx.user.id, workerInstanceId(instance));
  }),

  restoreConfig: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.restoreConfig(ctx.user.id, undefined, workerInstanceId(instance));
  }),

  // ── Gateway ───────────────────────────────────────────────────

  gatewayStatus: organizationMemberProcedure.query(async ({ ctx, input }) => {
    try {
      const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(ctx.user.id, workerInstanceId(instance));
    } catch (err) {
      if (err instanceof KiloClawApiError && (err.statusCode === 404 || err.statusCode === 409)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway control unavailable' });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch gateway status',
      });
    }
  }),

  gatewayReady: organizationMemberProcedure.query(async ({ ctx, input }) => {
    try {
      const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return await client.getGatewayReady(ctx.user.id, workerInstanceId(instance));
    } catch (err) {
      if (err instanceof KiloClawApiError && (err.statusCode === 404 || err.statusCode === 409)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway ready check unavailable' });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch gateway ready state',
      });
    }
  }),

  controllerVersion: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.getControllerVersion(ctx.user.id, workerInstanceId(instance));
  }),

  // ── Pairing ───────────────────────────────────────────────────

  listPairingRequests: organizationMemberProcedure
    .input(z.object({ organizationId: z.uuid(), refresh: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return client.listPairingRequests(ctx.user.id, input.refresh, workerInstanceId(instance));
    }),

  approvePairingRequest: organizationMemberMutationProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        channel: z.string().min(1),
        code: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return client.approvePairingRequest(
        ctx.user.id,
        input.channel,
        input.code,
        workerInstanceId(instance)
      );
    }),

  listDevicePairingRequests: organizationMemberProcedure
    .input(z.object({ organizationId: z.uuid(), refresh: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return client.listDevicePairingRequests(
        ctx.user.id,
        input.refresh,
        workerInstanceId(instance)
      );
    }),

  approveDevicePairingRequest: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), requestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      return client.approveDevicePairingRequest(
        ctx.user.id,
        input.requestId,
        workerInstanceId(instance)
      );
    }),

  // ── Versioning ────────────────────────────────────────────────

  listAvailableVersions: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        offset: z.number().min(0).default(0),
        limit: z.number().min(1).max(100).default(25),
      })
    )
    .query(async ({ input }) => {
      const { offset, limit } = input;

      const latestPerVersion = db
        .selectDistinctOn(
          [kiloclaw_image_catalog.openclaw_version, kiloclaw_image_catalog.variant],
          {
            openclaw_version: kiloclaw_image_catalog.openclaw_version,
            variant: kiloclaw_image_catalog.variant,
            image_tag: kiloclaw_image_catalog.image_tag,
            description: kiloclaw_image_catalog.description,
            published_at: kiloclaw_image_catalog.published_at,
          }
        )
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.status, 'available'))
        .orderBy(
          kiloclaw_image_catalog.openclaw_version,
          kiloclaw_image_catalog.variant,
          desc(kiloclaw_image_catalog.published_at)
        )
        .as('latest_per_version');

      const [items, countResult] = await Promise.all([
        db
          .select()
          .from(latestPerVersion)
          .orderBy(desc(latestPerVersion.published_at))
          .offset(offset)
          .limit(limit),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(latestPerVersion),
      ]);

      const totalCount = countResult[0]?.count ?? 0;

      return {
        items,
        pagination: { offset, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      };
    }),

  getMyPin: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
    if (!instance) return null;

    const [result] = await db
      .select({
        pin: kiloclaw_version_pins,
        openclaw_version: kiloclaw_image_catalog.openclaw_version,
        variant: kiloclaw_image_catalog.variant,
      })
      .from(kiloclaw_version_pins)
      .leftJoin(
        kiloclaw_image_catalog,
        eq(kiloclaw_version_pins.image_tag, kiloclaw_image_catalog.image_tag)
      )
      .where(eq(kiloclaw_version_pins.instance_id, instance.id))
      .limit(1);

    if (!result) return null;
    return {
      ...result.pin,
      pinnedBySelf: result.pin.pinned_by === ctx.user.id,
      openclaw_version: result.openclaw_version,
      variant: result.variant,
    };
  }),

  setMyPin: organizationMemberMutationProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        imageTag: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);

      const [version] = await db
        .select()
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.image_tag, input.imageTag))
        .limit(1);

      if (!version) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Image tag '${input.imageTag}' not found in catalog`,
        });
      }

      if (version.status !== 'available') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot pin to version with status '${version.status}'. Only 'available' versions can be pinned.`,
        });
      }

      const [existingPin] = await db
        .select({ pinned_by: kiloclaw_version_pins.pinned_by })
        .from(kiloclaw_version_pins)
        .where(eq(kiloclaw_version_pins.instance_id, instance.id))
        .limit(1);

      if (existingPin && existingPin.pinned_by !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'Your version is pinned by an admin. Contact your Kilo admin to change or remove the pin.',
        });
      }

      let result: typeof kiloclaw_version_pins.$inferSelect | undefined;
      try {
        [result] = await db
          .insert(kiloclaw_version_pins)
          .values({
            instance_id: instance.id,
            image_tag: input.imageTag,
            pinned_by: ctx.user.id,
            reason: input.reason ?? null,
          })
          .onConflictDoUpdate({
            target: kiloclaw_version_pins.instance_id,
            set: {
              image_tag: input.imageTag,
              pinned_by: ctx.user.id,
              reason: input.reason ?? null,
              updated_at: new Date().toISOString(),
            },
          })
          .returning();
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('foreign key')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Image tag '${input.imageTag}' not found in catalog`,
          });
        }
        throw err;
      }

      if (!result) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create pin' });
      }

      return result;
    }),

  removeMyPin: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);

    const [deleted] = await db
      .delete(kiloclaw_version_pins)
      .where(
        and(
          eq(kiloclaw_version_pins.instance_id, instance.id),
          eq(kiloclaw_version_pins.pinned_by, ctx.user.id)
        )
      )
      .returning();

    if (!deleted) {
      const [existingPin] = await db
        .select({ pinned_by: kiloclaw_version_pins.pinned_by })
        .from(kiloclaw_version_pins)
        .where(eq(kiloclaw_version_pins.instance_id, instance.id))
        .limit(1);

      if (existingPin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your version is pinned by an admin. Contact your Kilo admin to remove the pin.',
        });
      }

      throw new TRPCError({ code: 'NOT_FOUND', message: 'No pin found for your account' });
    }

    return { success: true };
  }),

  // ── Stream Chat ────────────────────────────────────────────────

  getStreamChatCredentials: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.getStreamChatCredentials(ctx.user.id, workerInstanceId(instance));
  }),

  sendChatMessage: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), message: z.string().min(1).max(32_000) }))
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      try {
        return await client.sendChatMessage(ctx.user.id, input.message, instance.id);
      } catch (err) {
        if (err instanceof KiloClawApiError) {
          const { message } = getKiloClawApiErrorPayload(err);
          const code =
            err.statusCode === 404
              ? 'NOT_FOUND'
              : err.statusCode === 503
                ? 'PRECONDITION_FAILED'
                : 'INTERNAL_SERVER_ERROR';
          throw new TRPCError({
            code,
            message: message ?? 'Failed to send chat message',
          });
        }
        throw err;
      }
    }),

  // ── Google integration ────────────────────────────────────────

  getGoogleSetupCommand: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const token = generateApiToken(ctx.user, undefined, {
      expiresIn: TOKEN_EXPIRY.oneHour,
    });
    const isDev = process.env.NODE_ENV === 'development';
    const imageTag = isDev ? ':dev' : ':latest';
    const workerFlag = isDev ? ' --worker-url=http://localhost:8795' : '';
    const gmailPushFlag = isDev ? ' --gmail-push-worker-url=${GMAIL_PUSH_WORKER_URL}' : '';
    // Pass instance ID so the container stores credentials on the org instance,
    // not the personal one. Requires google-setup container support for --instance-id.
    const instanceFlag = ` --instance-id=${instance.id}`;
    const imageUrl = `ghcr.io/kilo-org/google-setup${imageTag}`;
    return {
      command: `docker pull ${imageUrl} && docker run -it --network host ${imageUrl} --token="${token}"${workerFlag}${gmailPushFlag}${instanceFlag}`,
    };
  }),

  disconnectGoogle: organizationMemberMutationProcedure.mutation(async ({ ctx, input }) => {
    const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
    const client = new KiloClawInternalClient();
    return client.clearGoogleCredentials(ctx.user.id, workerInstanceId(instance));
  }),

  setGmailNotifications: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      try {
        if (input.enabled) {
          return await client.enableGmailNotifications(ctx.user.id, workerInstanceId(instance));
        }
        return await client.disableGmailNotifications(ctx.user.id, workerInstanceId(instance));
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode >= 400 && err.statusCode < 500) {
          let message = `Failed to update Gmail notifications (${err.statusCode})`;
          try {
            const parsed = JSON.parse(err.responseBody);
            if (typeof parsed.error === 'string') message = parsed.error;
            else if (typeof parsed.message === 'string') message = parsed.message;
          } catch {
            if (err.responseBody) message = err.responseBody;
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw err;
      }
    }),

  // ── Kilo CLI Run ──────────────────────────────────────────────

  startKiloCliRun: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), prompt: z.string().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();

      let result: Awaited<ReturnType<KiloClawInternalClient['startKiloCliRun']>>;
      try {
        result = await client.startKiloCliRun(
          ctx.user.id,
          input.prompt,
          workerInstanceId(instance)
        );
      } catch (err) {
        if (err instanceof KiloClawApiError) {
          const { code, message } = getKiloClawApiErrorPayload(err);
          if (code === 'controller_route_unavailable') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Instance needs redeploy to support recovery',
              cause: new UpstreamApiError('controller_route_unavailable'),
            });
          }
          if (err.statusCode === 409) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: message ?? 'Instance is busy',
              cause: code ? new UpstreamApiError(code) : undefined,
            });
          }
        }
        throw err;
      }

      const runId = await createCliRun({
        userId: ctx.user.id,
        instanceId: instance.id,
        prompt: input.prompt,
        startedAt: result.startedAt,
        initiatedByAdminId: null,
      });

      return { ...result, id: runId };
    }),

  getKiloCliRunStatus: organizationMemberProcedure
    .input(z.object({ organizationId: z.uuid(), runId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      return getCliRunStatus({
        runId: input.runId,
        userId: ctx.user.id,
        instanceId: instance.id,
        workerInstanceId: workerInstanceId(instance),
      });
    }),

  cancelKiloCliRun: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), runId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
      const result = await cancelCliRun({
        runId: input.runId,
        userId: ctx.user.id,
        instanceId: instance.id,
        workerInstanceId: workerInstanceId(instance),
      });

      if (!result.runFound) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Kilo CLI run not found',
        });
      }

      return { ok: result.ok };
    }),

  listKiloCliRuns: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ ctx, input }) => {
      const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
      if (!instance) return { runs: [] };
      const limit = input.limit;
      const runs = await db
        .select()
        .from(kiloclaw_cli_runs)
        .where(
          and(
            eq(kiloclaw_cli_runs.user_id, ctx.user.id),
            eq(kiloclaw_cli_runs.instance_id, instance.id)
          )
        )
        .orderBy(desc(kiloclaw_cli_runs.started_at))
        .limit(limit);

      return { runs };
    }),

  // ── File operations ───────────────────────────────────────────

  fileTree: organizationMemberProcedure.query(async ({ ctx, input }) => {
    try {
      const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
      const client = new KiloClawInternalClient();
      const result = await client.getFileTree(ctx.user.id, workerInstanceId(instance));
      return result.tree;
    } catch (err) {
      handleFileOperationError(err, 'fetch file tree');
    }
  }),

  readFile: organizationMemberProcedure
    .input(z.object({ organizationId: z.uuid(), path: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const instance = await getActiveOrgInstance(ctx.user.id, input.organizationId);
        const client = new KiloClawInternalClient();
        return await client.readFile(ctx.user.id, input.path, workerInstanceId(instance));
      } catch (err) {
        handleFileOperationError(err, 'read file');
      }
    }),

  writeFile: organizationMemberMutationProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        path: z.string().min(1),
        content: z.string(),
        etag: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
        const client = new KiloClawInternalClient();
        let content = input.content;

        if (input.path === 'openclaw.json') {
          let userConfig: unknown;
          try {
            userConfig = JSON.parse(content);
          } catch {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'openclaw.json must be valid JSON',
            });
          }
          if (typeof userConfig !== 'object' || userConfig === null || Array.isArray(userConfig)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'openclaw.json must be a JSON object',
            });
          }
          content = JSON.stringify(userConfig, null, 2);
        }

        return await client.writeFile(
          ctx.user.id,
          input.path,
          content,
          input.etag,
          workerInstanceId(instance)
        );
      } catch (err) {
        handleFileOperationError(err, 'write file');
      }
    }),

  patchOpenclawConfig: organizationMemberMutationProcedure
    .input(z.object({ organizationId: z.uuid(), patch: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const instance = await requireOrgInstance(ctx.user.id, input.organizationId);
        const client = new KiloClawInternalClient();
        return await client.patchOpenclawConfig(
          ctx.user.id,
          input.patch,
          workerInstanceId(instance)
        );
      } catch (err) {
        handleFileOperationError(err, 'patch openclaw config');
      }
    }),
});
