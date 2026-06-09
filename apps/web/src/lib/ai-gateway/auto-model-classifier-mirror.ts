import { after } from 'next/server';
import { AUTO_MODEL_CLASSIFIER_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import { warnExceptInTest } from '@/lib/utils.server';

type ScheduleAutoModelClassifierMirrorParams = {
  request: Request;
  path: '/chat/completions' | '/responses' | '/messages';
  bodyText: string;
};

type BackgroundScheduler = (work: () => void | Promise<void>) => void;

type AutoModelClassifierMirrorOptions = {
  workerUrl?: string;
  authToken?: string;
  onError?: (message: string, data: { error: string }) => void;
};

function serializeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function sendAutoModelClassifierMirror({
  request,
  path,
  bodyText,
  options,
}: ScheduleAutoModelClassifierMirrorParams & {
  options: AutoModelClassifierMirrorOptions;
}): Promise<void> {
  const workerUrl = options.workerUrl ?? AUTO_MODEL_CLASSIFIER_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  if (!workerUrl || !authToken) return;

  const response = await fetch(`${workerUrl}/classify`, {
    method: 'POST',
    headers: new Headers({
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
    }),
    body: JSON.stringify({
      path,
      receivedAt: new Date().toISOString(),
      headers: serializeHeaders(request.headers),
      body: bodyText,
    }),
  });

  if (!response.ok) {
    throw new Error(`classifier worker returned ${response.status}`);
  }
}

export function scheduleAutoModelClassifierMirror(
  params: ScheduleAutoModelClassifierMirrorParams,
  schedule: BackgroundScheduler = after,
  options: AutoModelClassifierMirrorOptions = {}
): void {
  schedule(async () => {
    try {
      await sendAutoModelClassifierMirror({ ...params, options });
    } catch (error) {
      const onError = options.onError ?? warnExceptInTest;
      onError('Auto model classifier mirror request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
