import { GLANCEABLE_STALE_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { getWorkerDb } from '@kilocode/db/client';
import { user_activity_tokens, user_push_tokens } from '@kilocode/db/schema';
import { pushDataSchema, SESSION_LIVE_ACTIVITY_MAX_AGE_MS } from '@kilocode/notifications';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { sendLiveActivityApns, type ApnsCredentials } from './apns-live-activity';
import { sendWidgetApns } from './apns-widget';
import { sendPushNotifications } from './expo-push';
import type { GlanceableDeliveryDeps, IosActivityToken } from './glanceable-delivery';
import { sessionCardSourceSchema, sessionLiveUpdateExpoMessage } from './session-card-delivery';

const deliveryExtrasSchema = z.object({
  liveActivitySnapshot: z.record(z.string(), z.unknown()).optional(),
  sessionCards: sessionCardSourceSchema.array().optional(),
});

/** Per-refresh I/O dependencies, shared by every entrypoint through the user DO. */
export function glanceableDeliveryDeps(env: Env): GlanceableDeliveryDeps {
  let db: ReturnType<typeof getWorkerDb> | undefined;
  const getDbForCall = () => (db ??= getWorkerDb(env.HYPERDRIVE.connectionString));
  const iosTargets = new Map<
    string,
    Pick<typeof user_activity_tokens.$inferSelect, 'id' | 'updated_at' | 'kind'>
  >();
  // Retire a token that can no longer reach a card: a successful end, or an
  // APNs 410 on any event. A delayed end must not delete another activity or a
  // registration refreshed since this delivery selected its target.
  const retireIosTarget = async (token: string) => {
    const target = iosTargets.get(token);
    if (!target) return;
    await getDbForCall()
      .delete(user_activity_tokens)
      .where(
        and(
          eq(user_activity_tokens.id, target.id),
          eq(user_activity_tokens.token, token),
          eq(user_activity_tokens.kind, target.kind),
          eq(user_activity_tokens.updated_at, target.updated_at)
        )
      );
  };

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
        // The route rechecks organization membership: a 403 means the user
        // lost the scope, so its session cards must end at once.
        return response.status === 403 ? 'access_denied' : null;
      }
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        console.warn('Glanceable snapshot route returned a non-JSON response');
        return null;
      }
      const raw: unknown = await response.json().catch(() => null);
      const body = typeof raw === 'object' && raw !== null ? raw : {};
      const parsed = pushDataSchema.safeParse({ type: 'active_agents_glanceable', ...body });
      if (!parsed.success || parsed.data.type !== 'active_agents_glanceable') {
        console.warn('Glanceable snapshot route returned an invalid snapshot');
        return null;
      }
      // Server-only fields beside the snapshot. A web build older than session
      // cards omits both, and the aggregate card then counts every session.
      const extras = deliveryExtrasSchema.safeParse(body);
      const liveActivity =
        extras.success && extras.data.liveActivitySnapshot !== undefined
          ? pushDataSchema.safeParse({
              type: 'active_agents_glanceable',
              ...extras.data.liveActivitySnapshot,
            })
          : undefined;
      if (
        !extras.success ||
        (liveActivity !== undefined &&
          (!liveActivity.success || liveActivity.data.type !== 'active_agents_glanceable'))
      ) {
        console.warn('Glanceable snapshot route returned invalid session card facts');
        return null;
      }
      return {
        ...parsed.data,
        ...(liveActivity?.success && liveActivity.data.type === 'active_agents_glanceable'
          ? { liveActivitySnapshot: liveActivity.data }
          : {}),
        ...(extras.data.sessionCards === undefined
          ? {}
          : { sessionCards: extras.data.sessionCards }),
      };
    },
    listIosSessionActivityTokens: async (userId, organizationId) => {
      // ActivityKit ends a card at its maximum lifetime, often with no APNs
      // rejection to tell the server. Compare on the database clock.
      const expired = sql<boolean>`${user_activity_tokens.created_at} <= now() - make_interval(secs => ${SESSION_LIVE_ACTIVITY_MAX_AGE_MS / 1000})`;
      const rows = await getDbForCall()
        .select({
          token: user_activity_tokens.token,
          sessionId: user_activity_tokens.session_id,
          kind: user_activity_tokens.kind,
          id: user_activity_tokens.id,
          updated_at: user_activity_tokens.updated_at,
          expired,
        })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            organizationId === null
              ? isNull(user_activity_tokens.organization_id)
              : eq(user_activity_tokens.organization_id, organizationId),
            eq(user_activity_tokens.kind, 'ios_session_activity'),
            isNull(user_activity_tokens.superseded_at),
            isNotNull(user_activity_tokens.session_id)
          )
        );
      // An expired row can no longer reach a card: drop it, so its session
      // counts as unfollowed again. The age check repeats in the delete, so a
      // row renewed meanwhile stays.
      await Promise.all(
        rows
          .filter(row => row.expired)
          .map(row =>
            getDbForCall()
              .delete(user_activity_tokens)
              .where(
                and(
                  eq(user_activity_tokens.id, row.id),
                  eq(user_activity_tokens.kind, 'ios_session_activity'),
                  expired
                )
              )
          )
      );
      const live = rows.filter(row => !row.expired);
      for (const row of live) {
        iosTargets.set(row.token, row);
      }
      return live.flatMap(row =>
        row.sessionId === null ? [] : [{ token: row.token, sessionId: row.sessionId }]
      );
    },
    sendIosSessionLiveActivity: async (send, timestampSeconds, isCurrent) => {
      const credentials = await readApnsCredentials(env);
      if (credentials === null || (isCurrent && !(await isCurrent()))) return false;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const result = await sendLiveActivityApns({
        credentials,
        tokens: [{ token: send.token, event: send.event }],
        contentState: send.content,
        nowSeconds,
        timestampSeconds,
        // The aggregate window, or the end of the quiet window after the last
        // activity for a working card: a stale card keeps its last-known
        // content with an honest time, and the layout draws its quiet warning
        // from this moment. It never reads as expired.
        staleDateSeconds: send.staleAtSeconds ?? nowSeconds + GLANCEABLE_STALE_MS / 1000,
        priority: send.priority,
        relevanceScore: send.relevanceScore,
        dismissalDateSeconds: send.dismissalDateSeconds,
        isCurrent,
        onEnded: retireIosTarget,
      });
      return result.ok === 1;
    },
    listAndroidSessionTokens: async (userId, organizationId) => {
      const rows = await getDbForCall()
        .select({ token: user_activity_tokens.token, sessionId: user_activity_tokens.session_id })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            organizationId === null
              ? isNull(user_activity_tokens.organization_id)
              : eq(user_activity_tokens.organization_id, organizationId),
            eq(user_activity_tokens.kind, 'android_session_ongoing'),
            isNull(user_activity_tokens.superseded_at),
            isNotNull(user_activity_tokens.session_id)
          )
        );
      return rows.flatMap(row =>
        row.sessionId === null ? [] : [{ token: row.token, sessionId: row.sessionId }]
      );
    },
    sendAndroidSessionLiveUpdate: async (send, isCurrent) => {
      const accessToken = await env.EXPO_ACCESS_TOKEN.get();
      if (isCurrent && !(await isCurrent())) return false;
      const result = await sendPushNotifications(
        [sessionLiveUpdateExpoMessage(send)],
        accessToken,
        isCurrent
      );
      const accepted = result.ticketTokenPairs.length > 0;
      // An accepted end and an unregistered device both leave nothing to
      // update: retire this one session row. The device's other rows stay.
      if ((accepted && send.event === 'end') || result.staleTokens.includes(send.token)) {
        await getDbForCall()
          .delete(user_activity_tokens)
          .where(
            and(
              eq(user_activity_tokens.token, send.token),
              eq(user_activity_tokens.kind, 'android_session_ongoing'),
              eq(user_activity_tokens.session_id, send.sessionId)
            )
          );
      }
      return accepted;
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
          superseded_at: user_activity_tokens.superseded_at,
        })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            orgPredicate,
            inArray(user_activity_tokens.kind, ['ios_activity', 'ios_push_to_start'])
          )
        )
        // Newest registration first, so `apnsSendsForTokens` can pick one live
        // target deterministically and never thrash between two candidates.
        .orderBy(desc(user_activity_tokens.updated_at), desc(user_activity_tokens.id));
      // Both kinds: an APNs 410 retires whichever registration it names, and a
      // dead push-to-start row would otherwise keep raising rejected starts.
      for (const row of rows) {
        iosTargets.set(row.token, row);
      }
      return rows.map(row => ({
        token: row.token,
        kind: row.kind as IosActivityToken['kind'],
        id: row.id,
        updated_at: row.updated_at,
        superseded: row.superseded_at !== null,
      }));
    },
    sendIosLiveActivity: async (
      tokens,
      contentState,
      startAlert,
      timestampSeconds,
      isCurrent,
      beforeEnd,
      onEndRejected,
      onStarted,
      relevanceScore
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
        // A card whose updates stop must dim rather than keep asserting counts
        // the device can no longer confirm. Same window the local sink uses.
        staleDateSeconds: Math.floor(Date.now() / 1000) + GLANCEABLE_STALE_MS / 1000,
        isCurrent,
        beforeEnd,
        onEndRejected,
        onStarted,
        relevanceScore,
        onEnded: retireIosTarget,
      });
      if (result.failed > 0) {
        console.warn('Some Live Activity APNs sends failed', {
          attempted: result.attempted,
          failed: result.failed,
        });
      }
    },
    sendIosWidgetHints: async (userId, organizationId, isCurrent) => {
      const orgPredicate =
        organizationId === null
          ? isNull(user_activity_tokens.organization_id)
          : eq(user_activity_tokens.organization_id, organizationId);
      const rows = await getDbForCall()
        .select({
          id: user_activity_tokens.id,
          token: user_activity_tokens.token,
          updated_at: user_activity_tokens.updated_at,
        })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            orgPredicate,
            eq(user_activity_tokens.kind, 'ios_widget')
          )
        );
      const credentials = await readApnsCredentials(env);
      if (!credentials || (isCurrent && !(await isCurrent()))) return;
      await sendWidgetApns({
        credentials,
        tokens: rows.map(row => row.token),
        isCurrent,
        onGone: async token => {
          const row = rows.find(candidate => candidate.token === token);
          if (!row) return;
          await getDbForCall()
            .delete(user_activity_tokens)
            .where(
              and(
                eq(user_activity_tokens.id, row.id),
                eq(user_activity_tokens.updated_at, row.updated_at),
                eq(user_activity_tokens.kind, 'ios_widget')
              )
            );
        },
      });
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
