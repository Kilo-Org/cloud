import { getWorkerDb } from '@kilocode/db/client';
import { user_activity_tokens, user_push_tokens } from '@kilocode/db/schema';
import { pushDataSchema } from '@kilocode/notifications';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { sendLiveActivityApns, type ApnsCredentials } from './apns-live-activity';
import { sendPushNotifications } from './expo-push';
import type { GlanceableDeliveryDeps, IosActivityToken } from './glanceable-delivery';

/** Per-refresh I/O dependencies, shared by every entrypoint through the user DO. */
export function glanceableDeliveryDeps(env: Env): GlanceableDeliveryDeps {
  let db: ReturnType<typeof getWorkerDb> | undefined;
  const getDbForCall = () => (db ??= getWorkerDb(env.HYPERDRIVE.connectionString));
  const iosTargets = new Map<
    string,
    Pick<typeof user_activity_tokens.$inferSelect, 'id' | 'updated_at'>
  >();

  return {
    buildSnapshot: async (userId, organizationId) => {
      const baseUrl = env.KILO_WEB_API_BASE_URL;
      if (!baseUrl) {
        console.warn('KILO_WEB_API_BASE_URL missing; skipping glanceable aggregate delivery');
        return null;
      }
      let internalApiSecret: string | undefined;
      try {
        internalApiSecret = await env.INTERNAL_API_SECRET.get();
      } catch {
        internalApiSecret = undefined;
      }
      if (!internalApiSecret) {
        console.warn('INTERNAL_API_SECRET missing; skipping glanceable aggregate delivery');
        return null;
      }

      const response = await fetch(`${baseUrl}/api/internal/glanceable-agents-snapshot`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-internal-secret': internalApiSecret,
        },
        body: JSON.stringify({ userId, organizationId }),
      });
      if (!response.ok) {
        console.warn('Glanceable snapshot route failed', { status: response.status });
        return null;
      }
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        console.warn('Glanceable snapshot route returned a non-JSON response');
        return null;
      }
      const raw: unknown = await response.json().catch(() => null);
      const candidate = {
        type: 'active_agents_glanceable',
        ...(typeof raw === 'object' && raw !== null ? raw : {}),
      };
      const parsed = pushDataSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.type !== 'active_agents_glanceable') {
        console.warn('Glanceable snapshot route returned an invalid snapshot');
        return null;
      }
      return parsed.data;
    },
    listIosActivityTokens: async (userId, organizationId) => {
      const orgPredicate =
        organizationId === null
          ? isNull(user_activity_tokens.organization_id)
          : eq(user_activity_tokens.organization_id, organizationId);
      const rows = await getDbForCall()
        .select({
          token: user_activity_tokens.token,
          kind: user_activity_tokens.kind,
          id: user_activity_tokens.id,
          updated_at: user_activity_tokens.updated_at,
        })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            orgPredicate,
            inArray(user_activity_tokens.kind, ['ios_activity', 'ios_push_to_start'])
          )
        );
      for (const row of rows) {
        if (row.kind === 'ios_activity') iosTargets.set(row.token, row);
      }
      return rows.map(row => ({ ...row, kind: row.kind as IosActivityToken['kind'] }));
    },
    sendIosLiveActivity: async (
      tokens,
      contentState,
      startAlert,
      timestampSeconds,
      isCurrent,
      beforeEnd,
      onEndRejected
    ) => {
      const credentials = await readApnsCredentials(env);
      if (credentials === null || (isCurrent && !(await isCurrent()))) return;
      const result = await sendLiveActivityApns({
        credentials,
        tokens,
        contentState,
        startAlert,
        nowSeconds: Math.floor(Date.now() / 1000),
        timestampSeconds,
        isCurrent,
        beforeEnd,
        onEndRejected,
        onEnded: async token => {
          const target = iosTargets.get(token);
          if (!target) return;
          // A delayed end must not delete a scope subscription, another activity,
          // or a registration refreshed since this delivery selected its target.
          await getDbForCall()
            .delete(user_activity_tokens)
            .where(
              and(
                eq(user_activity_tokens.id, target.id),
                eq(user_activity_tokens.token, token),
                eq(user_activity_tokens.kind, 'ios_activity'),
                eq(user_activity_tokens.updated_at, target.updated_at)
              )
            );
        },
      });
      if (result.failed > 0) {
        console.warn('Some Live Activity APNs sends failed', {
          attempted: result.attempted,
          failed: result.failed,
        });
      }
    },
    listIosExpoTokens: async userId => {
      const rows = await getDbForCall()
        .select({ token: user_push_tokens.token, locale: user_push_tokens.locale })
        .from(user_push_tokens)
        .where(and(eq(user_push_tokens.user_id, userId), eq(user_push_tokens.platform, 'ios')));
      return rows.map(row => ({ token: row.token, locale: row.locale }));
    },
    listAndroidExpoTokens: async userId => {
      const rows = await getDbForCall()
        .select({ token: user_push_tokens.token, locale: user_push_tokens.locale })
        .from(user_push_tokens)
        .where(
          and(
            eq(user_push_tokens.user_id, userId),
            eq(user_push_tokens.platform, 'android'),
            isNotNull(user_push_tokens.app_version)
          )
        );
      return rows.map(row => ({ token: row.token, locale: row.locale }));
    },
    hasAndroidOngoingToken: async (userId, organizationId) => {
      const orgPredicate =
        organizationId === null
          ? isNull(user_activity_tokens.organization_id)
          : eq(user_activity_tokens.organization_id, organizationId);
      const [row] = await getDbForCall()
        .select({ id: user_activity_tokens.id })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            orgPredicate,
            eq(user_activity_tokens.kind, 'android_ongoing')
          )
        )
        .limit(1);
      return row !== undefined;
    },
    sendExpoPush: async (messages, isCurrent) => {
      const accessToken = await env.EXPO_ACCESS_TOKEN.get();
      if (isCurrent && !(await isCurrent())) return;
      await sendPushNotifications(messages, accessToken, isCurrent);
    },
  };
}

async function readApnsCredentials(env: Env): Promise<ApnsCredentials | null> {
  const { APNS_TEAM_ID: teamId, APNS_KEY_ID: keyId, APNS_TOPIC: topic } = env;
  const privateKeyBinding = env.APNS_PRIVATE_KEY;
  if (!teamId || !keyId || !topic || !privateKeyBinding) {
    console.warn('APNs Live Activity credentials missing; skipping Live Activity delivery');
    return null;
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = await privateKeyBinding.get();
  } catch {
    console.warn('APNs Live Activity private key read failed; skipping Live Activity delivery');
    return null;
  }
  if (!privateKeyPem) {
    console.warn('APNs Live Activity private key empty; skipping Live Activity delivery');
    return null;
  }
  return { teamId, keyId, topic, privateKeyPem };
}
