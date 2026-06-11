import { normalizeClassifierInput } from '@kilocode/auto-routing-contracts';
import type { ClassifierApiKind, MirrorPayload } from '@kilocode/auto-routing-contracts';
import { after } from 'next/server';
import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import { warnExceptInTest } from '@/lib/utils.server';

type ScheduleAutoRoutingMirrorParams = {
  apiKind: ClassifierApiKind;
  // The parsed gateway request body. Provider transforms may mutate it after
  // scheduling, which is why the requested model and provider hints are
  // captured separately before any mutation.
  body: unknown;
  requestedModel: string;
  providerHints: MirrorPayload['input']['providerHints'];
  bodyBytes: number;
  userId: string;
  sessionId: string | null;
  machineId: string | null;
  clientRequestId: string | null;
  mode: string | null;
  userAgent: string | null;
  authContext?: Promise<{ organizationId?: string | null }>;
};

type BackgroundScheduler = (work: () => void | Promise<void>) => void;

type AutoRoutingMirrorOptions = {
  workerUrl?: string;
  authToken?: string;
  onError?: (message: string, data: { error: string }) => void;
};

async function sendAutoRoutingMirror(
  params: ScheduleAutoRoutingMirrorParams,
  options: AutoRoutingMirrorOptions
): Promise<void> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  if (!workerUrl || !authToken) return;

  // Normalizing here (in background work, off the request path) keeps the
  // mirror payload at a few KB instead of the full request body, and lets
  // requests the worker could not classify anyway skip the mirror call.
  const normalizedInput = normalizeClassifierInput(params.apiKind, params.body, {
    requestedModel: params.requestedModel,
    providerHints: params.providerHints,
  });
  if (!normalizedInput) {
    const onError = options.onError ?? warnExceptInTest;
    onError('Auto routing mirror skipped unclassifiable request body', {
      error: 'normalize_failed',
    });
    return;
  }

  const payload: MirrorPayload = {
    input: normalizedInput,
    userId: params.userId,
    sessionId: params.sessionId,
    machineId: params.machineId,
    clientRequestId: params.clientRequestId,
    mode: params.mode,
    userAgent: params.userAgent,
    bodyBytes: params.bodyBytes,
  };

  const response = await fetch(`${workerUrl}/decide`, {
    method: 'POST',
    headers: new Headers({
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
    }),
    body: JSON.stringify(payload),
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
      if ((await params.authContext)?.organizationId) return;
      await sendAutoRoutingMirror(params, options);
    } catch (error) {
      const onError = options.onError ?? warnExceptInTest;
      onError('Auto routing mirror request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
