import 'server-only';
import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { IS_DEVELOPMENT } from '@kilocode/web-shared/lib/constants';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';
import { parseAppShellSession, type AppShellSession } from '@/lib/app-shell/session';

/**
 * Binds one app-shell OAuth attempt to the browser that started it.
 *
 * The callback runs under `/api/integrations`, where the shell session cookie
 * is absent, and it must not trust a bare `state` URL — a leaked callback URL
 * would then complete the connect as that user. This cookie is minted by the
 * shell's own connect route and scoped to `/api/integrations`, so only this
 * cookie plus the signed state identify an app-shell caller.
 */
export const APP_SHELL_FLOW_COOKIE = 'kilo_app_shell_flow';

/** `Path` covers the provider routines and nothing else. */
export const APP_SHELL_FLOW_COOKIE_PATH = '/api/integrations';

/** Provider round trips are capped by the 10-minute OAuth state; allow a margin. */
const APP_SHELL_FLOW_TTL_SECONDS = 15 * 60;

function stateFingerprint(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

/**
 * The flow carries the shell session that started it, pepper binding included,
 * so a session revocation during the provider round trip also ends the flow.
 */
export function createAppShellFlowToken(input: {
  session: AppShellSession;
  state: string;
}): string {
  return createSignedToken({ ...input.session, stateHash: stateFingerprint(input.state) });
}

export function appShellFlowCookieOptions(): {
  path: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
} {
  return {
    path: APP_SHELL_FLOW_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: !IS_DEVELOPMENT,
    maxAge: APP_SHELL_FLOW_TTL_SECONDS,
  };
}

/**
 * The shell session the flow cookie binds to this exact state, or null when the
 * cookie is missing, forged, expired, or minted for another attempt.
 */
export function verifyAppShellFlowToken(
  request: NextRequest,
  state: string
): AppShellSession | null {
  const token = request.cookies.get(APP_SHELL_FLOW_COOKIE)?.value ?? null;
  return verifySignedToken(token, {
    ttlSeconds: APP_SHELL_FLOW_TTL_SECONDS,
    parse: payload => {
      if (payload.stateHash !== stateFingerprint(state)) return null;
      return parseAppShellSession(payload);
    },
  });
}
