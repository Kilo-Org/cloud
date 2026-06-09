import { createProxyRequest } from '../shared/http-proxy.js';
import type { OwnedRootHandlerContext } from './contracts.js';
import { isRecord, readBoundedBody } from './http-contract.js';
import { buildWrapperKiloProxyUrl, resolveLiveWrapperTarget } from './session-proxy.js';

const MAX_KILO_ERROR_JSON_BYTES = 64 * 1024;

async function isUnavailableKiloRuntimeResponse(response: Response): Promise<boolean> {
  if (response.status !== 502 && response.status !== 503) return false;
  const contentType = response.headers.get('content-type');
  if (!contentType?.toLowerCase().includes('application/json')) return false;
  const bytes = await readBoundedBody(response.clone(), MAX_KILO_ERROR_JSON_BYTES);
  if (!bytes) return false;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return (
      isRecord(parsed) &&
      (parsed.error === 'KILO_RUNTIME_UNAVAILABLE' || parsed.error === 'KILO_PROXY_ERROR')
    );
  } catch {
    return false;
  }
}

export async function handleLiveFirstSessionRead(params: {
  context: OwnedRootHandlerContext;
  persistedFallback: () => Promise<Response>;
  rewriteLiveResponse: (response: Response, kiloSessionId: string) => Promise<Response>;
}): Promise<Response> {
  const { context } = params;
  let liveWrapper;
  try {
    liveWrapper = await (context.deps?.resolveLiveWrapper ?? resolveLiveWrapperTarget)({
      env: context.env,
      userId: context.userId,
      cloudAgentSessionId: context.cloudAgentSessionId,
    });
  } catch {
    return params.persistedFallback();
  }
  if (!liveWrapper) return params.persistedFallback();

  const upstreamSearchParams = new URLSearchParams(context.url.searchParams);
  upstreamSearchParams.delete('directory');
  const upstreamSearch = upstreamSearchParams.size > 0 ? `?${upstreamSearchParams.toString()}` : '';
  const targetUrl = buildWrapperKiloProxyUrl({
    wrapperPort: liveWrapper.port,
    kiloRelativePath: context.kiloPath,
    search: upstreamSearch,
  });
  let response: Response;
  try {
    response = await liveWrapper.sandbox.containerFetch(
      createProxyRequest(context.request, targetUrl),
      liveWrapper.port
    );
  } catch {
    return params.persistedFallback();
  }
  if (await isUnavailableKiloRuntimeResponse(response)) return params.persistedFallback();
  return params.rewriteLiveResponse(response, context.kiloSessionId);
}
