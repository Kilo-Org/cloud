import { after } from 'next/server';
import { redactSensitiveHeaders } from '@kilocode/worker-utils/redact-headers';
import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import { warnExceptInTest } from '@/lib/utils.server';

type ScheduleAutoRoutingMirrorParams = {
  request: Request;
  path: '/chat/completions' | '/responses' | '/messages';
  bodyText: string;
};

type BackgroundScheduler = (work: () => void | Promise<void>) => void;

type AutoRoutingMirrorOptions = {
  workerUrl?: string;
  authToken?: string;
  onError?: (message: string, data: { error: string }) => void;
};

function serializeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function sendAutoRoutingMirror({
  request,
  path,
  bodyText,
  options,
}: ScheduleAutoRoutingMirrorParams & {
  options: AutoRoutingMirrorOptions;
}): Promise<void> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  if (!workerUrl || !authToken) return;

  const response = await fetch(`${workerUrl}/decide`, {
    method: 'POST',
    headers: new Headers({
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
    }),
    body: JSON.stringify({
      path,
      receivedAt: new Date().toISOString(),
      headers: redactSensitiveHeaders(serializeHeaders(request.headers)),
      body: bodyText,
    }),
  });

  if (!response.ok) {
    throw new Error(`auto routing worker returned ${response.status}`);
  }
}

export function scheduleAutoRoutingMirror(
  params: ScheduleAutoRoutingMirrorParams,
  schedule: BackgroundScheduler = after,
  options: AutoRoutingMirrorOptions = {}
): void {
  schedule(async () => {
    try {
      await sendAutoRoutingMirror({ ...params, options });
    } catch (error) {
      const onError = options.onError ?? warnExceptInTest;
      onError('Auto routing mirror request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
