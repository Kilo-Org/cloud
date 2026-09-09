import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user/server';
import { consumeGitHubUserAuthorizationState } from '@/lib/integrations/platforms/github/user-authorization-state';
import { exchangeAndStoreGitHubUserAuthorization } from '@/lib/integrations/platforms/github/user-authorization';

function redirectWithStatus(key: 'success' | 'error', value: string): NextResponse {
  const target = new URL('/integrations/github', APP_URL);
  target.searchParams.set(key, value);
  target.searchParams.set('flow', 'user-connect');
  return NextResponse.redirect(target);
}

function safeCallbackContext(searchParams: URLSearchParams) {
  const state = searchParams.get('state');
  return {
    hasCode: Boolean(searchParams.get('code')),
    hasState: Boolean(state),
    stateHash: state ? createHash('sha256').update(state).digest('hex').slice(0, 8) : null,
    hasProviderError: Boolean(searchParams.get('error')),
  };
}

function validOAuthCode(code: string | null): string | null {
  if (!code || code.length > 2048 || !/^[A-Za-z0-9._~+/-]+$/.test(code)) return null;
  return code;
}

type CallbackStage = 'authenticate_user' | 'consume_state' | 'exchange_and_store_authorization';

export async function GET(request: NextRequest) {
  let stage: CallbackStage = 'authenticate_user';
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    if (searchParams.get('error')) {
      return redirectWithStatus('error', 'authorization_cancelled');
    }

    const code = validOAuthCode(searchParams.get('code'));
    if (!code) {
      return redirectWithStatus('error', 'missing_code');
    }

    stage = 'consume_state';
    const state = await consumeGitHubUserAuthorizationState(searchParams.get('state'), user.id);
    if (state.status === 'storage_error') {
      captureMessage('GitHub user authorization callback storage failure', {
        level: 'error',
        tags: { endpoint: 'github/user-connect/callback', stage, reason: state.reason },
        extra: safeCallbackContext(searchParams),
      });
      return redirectWithStatus('error', 'connection_failed');
    }
    if (state.status === 'invalid') {
      captureMessage('GitHub user authorization callback invalid state', {
        level: 'warning',
        tags: { endpoint: 'github/user-connect/callback', stage, reason: state.reason },
        extra: safeCallbackContext(searchParams),
      });
      return redirectWithStatus(
        'error',
        state.reason === 'user_mismatch' ? 'account_mismatch' : 'invalid_state'
      );
    }

    stage = 'exchange_and_store_authorization';
    const result = await exchangeAndStoreGitHubUserAuthorization({
      kiloUserId: user.id,
      code,
      codeVerifier: state.codeVerifier,
    });
    if (result.status !== 'connected') {
      return redirectWithStatus('error', result.status);
    }

    return redirectWithStatus('success', 'user_connected');
  } catch {
    captureException(new Error('GitHub user authorization callback failed'), {
      tags: { endpoint: 'github/user-connect/callback', stage, reason: 'operation_failed' },
      extra: safeCallbackContext(request.nextUrl.searchParams),
    });
    return redirectWithStatus('error', 'connection_failed');
  }
}
