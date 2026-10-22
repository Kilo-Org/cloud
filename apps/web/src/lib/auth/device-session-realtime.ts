import 'server-only';

import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import {
  INTERNAL_API_SECRET,
  SESSION_INGEST_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';
import { fetchWithinBudget } from '@/lib/bounded-service-fetch';
import { runAfterResponse } from '@/lib/after-response';

type Target = { name: string; url: string; body: Record<string, string> };

function httpBaseUrl(value: string): string {
  const fallback = value.replace(/\/$/, '');
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') {
      url.protocol = 'http:';
    } else if (url.protocol === 'wss:') {
      url.protocol = 'https:';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function targets(params: { kiloUserId: string; deviceSessionId?: string }): Target[] {
  const eventServiceUrl = getEnvVariable('NEXT_PUBLIC_EVENT_SERVICE_URL') || '';
  const shared = {
    ...(params.deviceSessionId ? { deviceSessionId: params.deviceSessionId } : {}),
  };
  return [
    ...(SESSION_INGEST_WORKER_URL
      ? [
          {
            name: 'session-ingest',
            url: `${SESSION_INGEST_WORKER_URL.replace(/\/$/, '')}/internal/device-session/revoke`,
            body: { kiloUserId: params.kiloUserId, ...shared },
          },
        ]
      : []),
    ...(eventServiceUrl
      ? [
          {
            name: 'event-service',
            url: `${httpBaseUrl(eventServiceUrl)}/internal/device-session/revoke`,
            body: { userId: params.kiloUserId, ...shared },
          },
        ]
      : []),
  ];
}

/**
 * Ask the realtime owners to close sockets authenticated by a revoked device
 * session, or all sockets for the user when no session id is supplied.
 * Revocation is already committed when this runs, so delivery is best-effort:
 * a failure must not undo or block the revocation. No token, secret or request
 * body is logged.
 */
export async function closeDeviceSessionRealtimeConnections(params: {
  kiloUserId: string;
  deviceSessionId?: string;
}): Promise<void> {
  if (!INTERNAL_API_SECRET) return;

  await Promise.allSettled(
    targets(params).map(async target => {
      try {
        const response = await fetchWithinBudget(target.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Internal-Secret': INTERNAL_API_SECRET,
          },
          body: JSON.stringify(target.body),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          console.error('[device-session] realtime close refused', {
            target: target.name,
            status: response.status,
          });
        }
      } catch (error) {
        console.error('[device-session] realtime close failed', {
          target: target.name,
          errorClass: error instanceof Error ? error.name : typeof error,
        });
      }
    })
  );
}

/**
 * Run the close after the current response so a serverless invocation stays
 * alive for it. Callers must invoke this only once the revocation is committed.
 */
export async function scheduleDeviceSessionRealtimeClose(params: {
  kiloUserId: string;
  deviceSessionId?: string;
}): Promise<void> {
  await runAfterResponse(() => closeDeviceSessionRealtimeConnections(params));
}
