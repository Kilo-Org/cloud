import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';

export type AutoFixPrCallbackTarget = {
  url: string;
  headers: { 'X-Callback-Token': string };
};

export async function buildAutoFixPrCallbackTarget(params: {
  apiUrl: string;
  ticketId: string;
  callbackTokenSecret: string;
}): Promise<AutoFixPrCallbackTarget> {
  const callbackUrl = new URL('/api/internal/auto-fix/pr-callback', params.apiUrl);
  callbackUrl.searchParams.set('ticketId', params.ticketId);

  return {
    url: callbackUrl.toString(),
    headers: {
      'X-Callback-Token': await deriveCallbackToken({
        secret: params.callbackTokenSecret,
        scope: 'auto-fix-pr-callback',
        resourceParts: [params.ticketId],
      }),
    },
  };
}
