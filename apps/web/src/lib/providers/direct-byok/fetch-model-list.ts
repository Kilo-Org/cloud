// Model-list endpoints are third-party hosts, so the response is only usable when it comes from
// the configured origin, is JSON, and stays within a size and time budget that the sync runtime
// can afford. Anything else leaves the provider's stored list untouched.
const MODEL_LIST_TIMEOUT_MS = 20_000;
const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024;
const MODEL_LIST_MAX_REDIRECTS = 3;

const JSON_MEDIA_TYPE = /^application\/(?:json|[\w.+-]*\+json)$/i;

export type ModelListFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
};

/** Fetches a model list as raw JSON, restricted to the origin of `url`. */
export async function fetchModelListJson(
  url: string,
  description: string,
  options: ModelListFetchOptions = {}
): Promise<unknown> {
  const origin = new URL(url).origin;
  const maxBytes = options.maxBytes ?? MODEL_LIST_MAX_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS);
  let current = url;

  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'request failed';
      throw new Error(`Failed to fetch ${description}: ${reason}`, { cause: error });
    }

    // A runtime that follows a redirect anyway reports the URL it actually reached.
    if (response.url && new URL(response.url).origin !== origin) {
      await discardBody(response);
      throw new Error(`Failed to fetch ${description}: request left the configured origin`);
    }

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Failed to fetch ${description}: redirect without a location`);
      }
      if (redirects >= MODEL_LIST_MAX_REDIRECTS) {
        throw new Error(`Failed to fetch ${description}: too many redirects`);
      }
      const next = new URL(location, current);
      if (next.origin !== origin) {
        throw new Error(`Failed to fetch ${description}: request left the configured origin`);
      }
      current = next.toString();
      continue;
    }

    if (!response.ok) {
      await discardBody(response);
      throw new Error(`Failed to fetch ${description}: ${response.status} ${response.statusText}`);
    }

    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!JSON_MEDIA_TYPE.test(mediaType)) {
      await discardBody(response);
      throw new Error(
        `Failed to fetch ${description}: unexpected content type ${mediaType || 'missing'}`
      );
    }

    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      await discardBody(response);
      throw new Error(`Failed to fetch ${description}: response body is too large`);
    }

    const body = await readBoundedBody(response, description, maxBytes);
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error(`Failed to fetch ${description}: response is not valid JSON`, {
        cause: error,
      });
    }
  }
}

async function readBoundedBody(
  response: Response,
  description: string,
  maxBytes: number
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Failed to fetch ${description}: response has no body`);

  const decoder = new TextDecoder();
  let text = '';
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Failed to fetch ${description}: response body is too large`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

async function discardBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}
