import {
  UTS_MAX_TOKENS_PER_CALL,
  UtsScopeSchema,
  type UtsEnvironment,
  audienceOfResource,
  audienceOfScope,
} from '@kilocode/uts-contracts';

/**
 * Request parameters of the OAuth endpoints (RFC 6749 section 3.1): a parameter sent without a
 * value counts as absent, and no parameter may repeat, except the RFC 8707 `resource`.
 */

export type Param =
  | { status: 'absent' }
  | { status: 'present'; value: string }
  | { status: 'repeated' };

export type Params = {
  one(name: string): Param;
  all(name: string): string[];
};

export function paramsOf(search: URLSearchParams): Params {
  const values = (name: string) => search.getAll(name).filter(value => value !== '');
  return {
    one(name) {
      const found = values(name);
      if (found.length === 0) return { status: 'absent' };
      if (found.length > 1) return { status: 'repeated' };
      return { status: 'present', value: found[0] };
    },
    all: values,
  };
}

/** A token request carries a handful of short parameters; a larger body is refused. */
const MAX_FORM_BYTES = 16 * 1024;

export type FormRead =
  | { status: 'ok'; params: Params }
  | { status: 'invalid'; description: string };

/**
 * The body as UTF-8 text, read chunk by chunk with a byte count: null as soon as the count passes
 * `max`, after the rest of the stream is cancelled, so a body without a `Content-Length` (or with
 * a false one) is never held whole in memory.
 */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads an `application/x-www-form-urlencoded` POST body (RFC 6749 sections 4.1.3 and 6). */
export async function readForm(request: Request): Promise<FormRead> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return { status: 'invalid', description: 'the body must be application/x-www-form-urlencoded' };
  }
  if (Number(request.headers.get('Content-Length') ?? '0') > MAX_FORM_BYTES) {
    return { status: 'invalid', description: 'the body is too large' };
  }
  const body = await readBoundedText(request.body, MAX_FORM_BYTES);
  if (body === null) return { status: 'invalid', description: 'the body is too large' };
  return { status: 'ok', params: paramsOf(new URLSearchParams(body)) };
}

/**
 * A `scope` value (RFC 6749 section 3.3): scopes separated by single spaces, each a UTS scope,
 * none repeated, at most `max`. Null when the value breaks any of these.
 */
export function parseScopes(value: string, max: number): string[] | null {
  const scopes = value.split(' ');
  if (scopes.length > max || new Set(scopes).size !== scopes.length) return null;
  return scopes.every(scope => UtsScopeSchema.safeParse(scope).success) ? scopes : null;
}

/**
 * The audiences that RFC 8707 `resource` values name in `environment`, without repeats; null when
 * a value names no Kilo service there or more than 8 services are named (`audienceOfResource`).
 */
export function audiencesOfResources(
  resources: readonly string[],
  environment: UtsEnvironment
): string[] | null {
  const audiences = new Set<string>();
  for (const resource of resources) {
    const audience = audienceOfResource(resource, environment);
    if (audience === null) return null;
    audiences.add(audience);
  }
  return audiences.size > UTS_MAX_TOKENS_PER_CALL ? null : [...audiences];
}

/**
 * RFC 8707 `invalid_target`: a scope whose audience is not among the named resources, or a named
 * resource that no scope belongs to.
 */
export function targetMismatch(scopes: readonly string[], audiences: readonly string[]): boolean {
  const scopeAudiences = new Set(scopes.map(audienceOfScope));
  return (
    scopes.some(scope => !audiences.includes(audienceOfScope(scope))) ||
    audiences.some(audience => !scopeAudiences.has(audience))
  );
}
