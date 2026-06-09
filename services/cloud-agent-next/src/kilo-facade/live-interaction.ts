import { createProxyRequest } from '../shared/http-proxy.js';
import type { KiloFacadeHandlerContext, SelectedOwnedRootHandlerContext } from './contracts.js';
import {
  invalidInteractionRequestBodyResponse,
  invalidUpstreamResponse,
  liveRuntimeUnavailableResponse,
  missingInteractionRequestResponse,
  readBoundedBody,
} from './http-contract.js';
import { resolveSelectedOwnedRoot } from './ownership.js';
import {
  buildWrapperKiloProxyUrl,
  resolveLiveWrapperTarget,
  type LiveWrapperTarget,
} from './session-proxy.js';

const MAX_INTERACTION_JSON_BYTES = 512 * 1024;
const MAX_INTERACTION_ENTRIES = 1_000;

export type LiveInteractionRequest = Record<string, unknown> & { id: string; sessionID: string };
export type LiveInteractionValidator<T extends LiveInteractionRequest> = (
  value: unknown
) => value is T;

export type SelectedRootLiveInteraction = {
  context: SelectedOwnedRootHandlerContext;
  list: <T extends LiveInteractionRequest>(params: {
    path: string;
    isEntry: LiveInteractionValidator<T>;
  }) => Promise<T[] | Response>;
  mutate: <T extends LiveInteractionRequest>(params: {
    listPath: string;
    mutationPath: string;
    requestID: string;
    isEntry: LiveInteractionValidator<T>;
    body?: Uint8Array;
  }) => Promise<Response>;
};

export type OpenSelectedRootLiveInteractionResult = SelectedRootLiveInteraction | Response;

function isBoundedContentLength(headers: Headers): boolean {
  const declaredLength = headers.get('content-length');
  if (declaredLength === null) return true;
  const byteLength = Number(declaredLength);
  return (
    Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= MAX_INTERACTION_JSON_BYTES
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!isBoundedContentLength(response.headers)) return invalidUpstreamResponse();
  const bytes = await readBoundedBody(response, MAX_INTERACTION_JSON_BYTES);
  if (!bytes) return invalidUpstreamResponse();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalidUpstreamResponse();
  }
}

function listIsValid<T extends LiveInteractionRequest>(
  value: unknown,
  isEntry: LiveInteractionValidator<T>
): value is T[] {
  return Array.isArray(value) && value.length <= MAX_INTERACTION_ENTRIES && value.every(isEntry);
}

async function fetchOnTarget(params: {
  target: LiveWrapperTarget;
  sourceRequest: Request;
  path: string;
  body?: Uint8Array;
}): Promise<Response | null> {
  const targetUrl = buildWrapperKiloProxyUrl({
    wrapperPort: params.target.port,
    kiloRelativePath: params.path,
    search: '',
  });
  const sourceRequest = new Request(params.sourceRequest.url, {
    method: params.sourceRequest.method,
    headers: params.sourceRequest.headers,
    ...(params.body ? { body: params.body } : {}),
  });
  try {
    return await params.target.sandbox.containerFetch(
      createProxyRequest(sourceRequest, new URL(targetUrl)),
      params.target.port
    );
  } catch {
    return null;
  }
}

async function isUnavailableRuntimeResponse(response: Response): Promise<boolean> {
  if (response.status !== 502 && response.status !== 503) return false;
  const parsed = await readBoundedJson(response.clone());
  return (
    !(parsed instanceof Response) &&
    typeof parsed === 'object' &&
    parsed !== null &&
    (Reflect.get(parsed, 'error') === 'KILO_RUNTIME_UNAVAILABLE' ||
      Reflect.get(parsed, 'error') === 'KILO_PROXY_ERROR')
  );
}

async function listSelectedRoot<T extends LiveInteractionRequest>(params: {
  target: LiveWrapperTarget;
  sourceRequest: Request;
  path: string;
  kiloSessionId: string;
  isEntry: LiveInteractionValidator<T>;
}): Promise<T[] | Response> {
  const response = await fetchOnTarget({
    target: params.target,
    sourceRequest: new Request(params.sourceRequest.url, { method: 'GET' }),
    path: params.path,
  });
  if (!response) return liveRuntimeUnavailableResponse();
  if (!response.ok)
    return (await isUnavailableRuntimeResponse(response))
      ? liveRuntimeUnavailableResponse()
      : response;
  const parsed = await readBoundedJson(response);
  if (parsed instanceof Response) return parsed;
  if (!listIsValid(parsed, params.isEntry)) return invalidUpstreamResponse();
  return parsed.filter(entry => entry.sessionID === params.kiloSessionId);
}

export async function readInteractionRequestBody(
  request: Request,
  validate: (value: unknown) => boolean
): Promise<Uint8Array | Response> {
  if (!isBoundedContentLength(request.headers)) return invalidInteractionRequestBodyResponse();
  const bytes = await readBoundedBody(new Response(request.body), MAX_INTERACTION_JSON_BYTES);
  if (!bytes) return invalidInteractionRequestBodyResponse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalidInteractionRequestBodyResponse();
  }
  return validate(parsed) ? bytes : invalidInteractionRequestBodyResponse();
}

async function openOwnedRootLiveInteraction(
  selected: SelectedOwnedRootHandlerContext
): Promise<OpenSelectedRootLiveInteractionResult> {
  let target: LiveWrapperTarget | null;
  try {
    target = await (selected.deps?.resolveLiveWrapper ?? resolveLiveWrapperTarget)({
      env: selected.env,
      userId: selected.userId,
      cloudAgentSessionId: selected.cloudAgentSessionId,
    });
  } catch {
    return liveRuntimeUnavailableResponse();
  }
  if (!target) return liveRuntimeUnavailableResponse();

  const resolvedTarget = target;
  const list: SelectedRootLiveInteraction['list'] = params =>
    listSelectedRoot({
      target: resolvedTarget,
      sourceRequest: selected.request,
      path: params.path,
      kiloSessionId: selected.kiloSessionId,
      isEntry: params.isEntry,
    });

  return {
    context: selected,
    list,
    mutate: async params => {
      const pending = await list({ path: params.listPath, isEntry: params.isEntry });
      if (pending instanceof Response) return pending;
      if (!pending.some(entry => entry.id === params.requestID)) {
        return missingInteractionRequestResponse();
      }
      const response = await fetchOnTarget({
        target,
        sourceRequest: selected.request,
        path: params.mutationPath,
        ...(params.body ? { body: params.body } : {}),
      });
      if (!response || (await isUnavailableRuntimeResponse(response))) {
        return liveRuntimeUnavailableResponse();
      }
      return response;
    },
  };
}

export async function openSelectedRootLiveInteraction(
  context: KiloFacadeHandlerContext
): Promise<OpenSelectedRootLiveInteractionResult> {
  const selected = await resolveSelectedOwnedRoot(context);
  return selected instanceof Response ? selected : openOwnedRootLiveInteraction(selected);
}
