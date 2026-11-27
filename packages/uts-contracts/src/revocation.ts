import { z } from 'zod';
import type { UtsEnvironment } from './environment';

/**
 * The UTS revocation feed (design 5.6, 7): a signed head and the list it covers, served by the
 * feed Worker over a service binding (`FeedReader`) and, for Vercel and Fly, over HTTPS. The
 * shapes match `@kilocode/verify` (phase 2), which verifies them; this module holds the shapes UTS
 * publishes and the transports that implement the library's ports.
 */

/** JWS `typ` of a signed feed head. */
export const FEED_HEAD_TYPE = 'kilo-feed-head+jwt';

const Base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The base64url SHA-256 of the list bytes, which names the list. */
export const FeedListHashSchema = Base64Url32Schema;

/**
 * The payload UTS signs: when the feed object signed it, as a JWT NumericDate in seconds, and the
 * base64url SHA-256 of the list bytes it covers.
 */
export const FeedHeadPayloadSchema = z.strictObject({
  iat: z.number().int().nonnegative(),
  list_hash: FeedListHashSchema,
});
export type FeedHeadPayload = z.infer<typeof FeedHeadPayloadSchema>;

/**
 * The list as UTS serves it: UTF-8 JSON. Times are JWT NumericDates in seconds; a token issued at
 * or before its subject's `revoked_before` is revoked. Every array is sorted and every key of
 * `revoked_before` in ascending order, so equal contents give equal bytes and the same hash.
 */
export const RevocationListWireSchema = z.strictObject({
  revoked_before: z.record(z.string().min(1), z.number().int().nonnegative()),
  /** Revoked grant, third-party family, device session and sandbox grant ids (`sid`). */
  revoked_sids: z.array(z.string().min(1)),
  /** Signing key ids removed in an emergency rotation. */
  revoked_kids: z.array(z.string().min(1)),
  /** Revoked PAT and org bot key ids. */
  revoked_pat_ids: z.array(z.string().min(1)),
  blocked_accounts: z.array(z.string().min(1)),
});
export type RevocationListWire = z.infer<typeof RevocationListWireSchema>;

/** Paths on the feed Worker's origin (`UTS_ENDPOINTS[env].feedOrigin`). */
export const UTS_FEED_HEAD_PATH = '/revocation/head';
/** Followed by the list hash. */
export const UTS_FEED_LIST_PATH_PREFIX = '/revocation/list/';
export const UTS_BOOTSTRAP_PATH = '/revocation/bootstrap';

/**
 * The STS audience and scope of the authenticated HTTPS feed (design 5.6). A Vercel or Fly
 * verifier sends an STS service token for exactly this audience and scope on every head, list and
 * bootstrap request; STS mints one only for a workload its policy lists.
 */
export const UTS_FEED_AUDIENCE = 'uts-feed';
export const UTS_FEED_READ_SCOPE = 'uts-feed:revocation.read';

/**
 * The STS workloads whose tokens the HTTPS feed admits, per environment: the web app (`web`, the
 * `kilocode-app` Vercel project) and the AI gateway (`ai-gateway`, the `kilocode-ai-gateway`
 * project). The names are the STS policy's workload names (decision Q84): the gateway's workload
 * is `ai-gateway`, while its user audience stays `kilo-gateway`. Production admits none until the
 * HTTPS feed is activated there. A valid token of any other workload is refused with 403.
 */
export const UTS_FEED_HTTPS_WORKLOADS: Readonly<Record<UtsEnvironment, readonly string[]>> = {
  production: [],
  staging: ['web', 'ai-gateway'],
  development: ['web', 'ai-gateway'],
};

/** Whole seconds since the served head's `iat`, on every HTTPS head and bootstrap answer. */
export const UTS_FEED_HEAD_AGE_HEADER = 'Kilo-Feed-Head-Age';

/**
 * The two ages of a UTS key set in whole seconds, measured at the feed Worker when it answers:
 * `newest` is its `Age` (since the newest signer keys were read), `oldest` its
 * `Kilo-Key-Set-Oldest-Age` (since the oldest held keys were read). A verifier counts the
 * 5-minute lifetime from `newest` and the 24-hour last-good limit from `oldest`, so a bootstrap
 * never restarts a held key's age (coordination with phases 2 and 4).
 */
export const KeySetAgesSchema = z
  .strictObject({
    newest: z.number().int().nonnegative(),
    oldest: z.number().int().nonnegative(),
  })
  .refine(ages => ages.newest <= ages.oldest, 'newest age above oldest age');
export type KeySetAges = z.infer<typeof KeySetAgesSchema>;

/**
 * The HTTPS bootstrap body: the UTS key set as served at `jwks_uri`, its ages, the current head,
 * and the list bytes that head covers as base64url (JSON cannot carry raw bytes, and the hash
 * covers the exact bytes). The response carries the same ages as `Age` and
 * `Kilo-Key-Set-Oldest-Age`.
 */
export const UtsBootstrapWireSchema = z.strictObject({
  jwks: z.record(z.string(), z.unknown()),
  key_ages: KeySetAgesSchema,
  head: z.string().min(1),
  list: z.string().regex(/^[A-Za-z0-9_-]*$/),
});
export type UtsBootstrapWire = z.infer<typeof UtsBootstrapWireSchema>;

/**
 * The feed Worker's named entrypoint for Worker verifiers. A verifier binds it with its own
 * deployed name as `props.caller` (a repository check); the feed Worker refuses a binding without
 * one.
 */
export const UTS_FEED_READER_ENTRYPOINT = 'FeedReader';

/**
 * The mint Worker's named entrypoint through which the feed Worker reads the two feed objects.
 * Only the mint Worker binds the feed objects, so only it writes to them (design 5.7).
 */
export const UTS_FEED_READS_ENTRYPOINT = 'FeedReads';

const Bytes = z.instanceof(Uint8Array);

const Refused = z.strictObject({ status: z.literal('refused') });
const Unavailable = z.strictObject({
  status: z.literal('unavailable'),
  retryAfterSeconds: z.number().int().positive(),
});

/**
 * What one feed object answers through `FeedReads`: its current head with the list hash it
 * covers and its signing time (NumericDate seconds); `unavailable` while the object holds no
 * fresh backfill (it never signs a list it cannot vouch for) or its call failed; `misconfigured`
 * when the object refused to load under its name or jurisdiction; `refused` when the binding's
 * `props.caller` is not the feed Worker of the mint Worker's own environment.
 */
export const FeedReadsHeadSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    head: z.string().min(1),
    listHash: FeedListHashSchema,
    issuedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('misconfigured') }),
  Refused,
]);
export type FeedReadsHead = z.infer<typeof FeedReadsHeadSchema>;

/** The list text of one of the object's recent lists, by hash, or `not_found`. */
export const FeedReadsListSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), list: z.string().min(1) }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('misconfigured') }),
  Refused,
]);
export type FeedReadsList = z.infer<typeof FeedReadsListSchema>;

/** The `FeedReads` entrypoint as the feed Worker's binding exposes it; results are validated. */
export type FeedReadsBinding = {
  head(feed: number): Promise<unknown>;
  list(feed: number, listHash: string): Promise<unknown>;
};

export const FeedReaderHeadSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), head: z.string().min(1) }),
  Unavailable,
  Refused,
]);
export const FeedReaderListSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), list: Bytes }),
  z.strictObject({ status: z.literal('not_found') }),
  Unavailable,
  Refused,
]);
export const FeedReaderBootstrapSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    jwks: z.record(z.string(), z.unknown()),
    keyAges: KeySetAgesSchema,
    head: z.string().min(1),
    list: Bytes,
  }),
  Unavailable,
  Refused,
]);
/** The key set with its two ages, from the feed Worker's held set; no feed object is read. */
export const FeedReaderJwksSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    jwks: z.record(z.string(), z.unknown()),
    keyAges: KeySetAgesSchema,
  }),
  Unavailable,
  Refused,
]);
export type FeedReaderHead = z.infer<typeof FeedReaderHeadSchema>;
export type FeedReaderList = z.infer<typeof FeedReaderListSchema>;
export type FeedReaderBootstrap = z.infer<typeof FeedReaderBootstrapSchema>;
export type FeedReaderJwks = z.infer<typeof FeedReaderJwksSchema>;

/** The `FeedReader` entrypoint as a verifier's binding exposes it; results are validated. */
export type FeedReaderBinding = {
  head(): Promise<unknown>;
  list(listHash: string): Promise<unknown>;
  bootstrap(): Promise<unknown>;
  jwks(): Promise<unknown>;
};

/**
 * `@kilocode/verify`'s `JwksSource` for a UTS set, declared here with the same shape: the key-set
 * body, `age` (the set's `Age`, `keyAges.newest`) and `oldestAge` (`Kilo-Key-Set-Oldest-Age`,
 * `keyAges.oldest`), whole seconds. The library allows null ages only for an STS set; this source
 * never answers them. Any rejection is a failed fetch.
 */
export type JwksSourcePort = (
  signal: AbortSignal
) => Promise<{ body: unknown; age: number; oldestAge: number }>;

/**
 * `@kilocode/verify`'s `RevocationFeedSource`, declared here with the same shape so UTS can
 * implement it without depending on the library. Any rejection is a failed fetch.
 */
export type RevocationFeedSourcePort = {
  head(signal: AbortSignal): Promise<string>;
  list(listHash: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
};

/**
 * `@kilocode/verify`'s `UtsBootstrapAnswer` and `UtsBootstrapSource`, with the same shapes. A
 * bootstrap without valid `keyAges` is refused (fail closed).
 */
export type UtsBootstrapAnswerPort = {
  jwks: unknown;
  keyAges: KeySetAges;
  head: string;
  list: Uint8Array<ArrayBuffer>;
};
export type UtsBootstrapSourcePort = (signal: AbortSignal) => Promise<UtsBootstrapAnswerPort>;

export type UtsFeedSources = {
  feed: RevocationFeedSourcePort;
  bootstrap: UtsBootstrapSourcePort;
};

/**
 * `Symbol.dispose` where the runtime has one. ES2024 defines none, so a consumer built for it
 * reads it here rather than from its lib; workerd and current Node have it.
 */
const runtimeDispose: unknown = Reflect.get(Symbol, 'dispose');
const DISPOSE = typeof runtimeDispose === 'symbol' ? runtimeDispose : undefined;

/**
 * Runs the RPC disposer of `result`, which workerd gives every object an RPC call returns. A
 * result that is not an object carries none, nor does any result where the runtime has no
 * `Symbol.dispose`.
 */
function disposeResult(result: unknown): void {
  if (DISPOSE === undefined || typeof result !== 'object' || result === null) return;
  const dispose: unknown = Reflect.get(result, DISPOSE);
  if (typeof dispose === 'function') dispose.call(result);
}

/**
 * The validated result of one RPC call, or a rejection when `signal` aborts first. The result is
 * copied by the parse and then disposed; one that lands after the abort is only disposed.
 */
async function rpcCall<Schema extends z.ZodType>(
  call: () => Promise<unknown>,
  schema: Schema,
  signal: AbortSignal
): Promise<z.output<Schema>> {
  signal.throwIfAborted();
  // A call that throws synchronously rejects like one whose promise rejects.
  const pending = new Promise<unknown>(resolve => resolve(call()));
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([pending, aborted.promise]);
    try {
      return schema.parse(result);
    } finally {
      disposeResult(result);
    }
  } catch (error) {
    void pending.then(disposeResult, () => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/**
 * The feed, bootstrap and key-set ports over a `FeedReader` service binding, for Worker
 * verifiers.
 */
export function feedReaderSources(
  binding: FeedReaderBinding
): UtsFeedSources & { jwks: JwksSourcePort } {
  return {
    feed: {
      async head(signal) {
        const read = await rpcCall(() => binding.head(), FeedReaderHeadSchema, signal);
        if (read.status !== 'ok') throw new Error(`feed head ${read.status}`);
        return read.head;
      },
      async list(listHash, signal) {
        const read = await rpcCall(() => binding.list(listHash), FeedReaderListSchema, signal);
        if (read.status !== 'ok') throw new Error(`feed list ${read.status}`);
        return copyBytes(read.list);
      },
    },
    async bootstrap(signal) {
      const read = await rpcCall(() => binding.bootstrap(), FeedReaderBootstrapSchema, signal);
      if (read.status !== 'ok') throw new Error(`bootstrap ${read.status}`);
      return {
        jwks: read.jwks,
        keyAges: read.keyAges,
        head: read.head,
        list: copyBytes(read.list),
      };
    },
    async jwks(signal) {
      const read = await rpcCall(() => binding.jwks(), FeedReaderJwksSchema, signal);
      if (read.status !== 'ok') throw new Error(`key set ${read.status}`);
      return { body: read.jwks, age: read.keyAges.newest, oldestAge: read.keyAges.oldest };
    },
  };
}

/**
 * The subset of `fetch` the HTTPS sources use. Every feed, head, list and bootstrap request needs
 * `Authorization: Bearer <STS token>` for `UTS_FEED_AUDIENCE` and `UTS_FEED_READ_SCOPE`; the
 * caller's fetcher adds it to `init.headers`, from its service-token client, on each call.
 */
export type FeedFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<Response>;

async function okResponse(
  fetcher: FeedFetch,
  url: string,
  accept: string,
  signal: AbortSignal
): Promise<Response> {
  const response = await fetcher(url, { signal, headers: { accept } });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`feed answered HTTP ${response.status}`);
  }
  return response;
}

/**
 * The feed and bootstrap ports over HTTPS on the feed Worker's origin, for Vercel and Fly
 * verifiers. A non-200 answer or a body of the wrong shape is a failed fetch. The head is asked
 * for with the `ETag` of the last head this source read (`If-None-Match`); a 304 answers that
 * head again, so an unchanged head costs no body. Only an answer to a later request replaces the
 * held head, so a late answer never brings back an older one.
 */
export function httpsFeedSources(
  feedOrigin: string,
  fetcher: FeedFetch = (url, init) => fetch(url, init)
): UtsFeedSources {
  const origin = feedOrigin.replace(/\/+$/, '');
  let held: { etag: string; head: string; request: number } | null = null;
  let requests = 0;
  return {
    feed: {
      async head(signal) {
        requests += 1;
        const request = requests;
        const condition = held;
        const response = await fetcher(`${origin}${UTS_FEED_HEAD_PATH}`, {
          signal,
          headers: {
            accept: 'application/jwt',
            ...(condition === null ? {} : { 'if-none-match': condition.etag }),
          },
        });
        if (response.status === 304 && condition !== null) {
          await response.body?.cancel();
          return condition.head;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`feed answered HTTP ${response.status}`);
        }
        const head = z
          .string()
          .min(1)
          .parse(await response.text());
        const etag = response.headers.get('etag');
        if (etag !== null && (held === null || held.request < request)) {
          held = { etag, head, request };
        }
        return head;
      },
      async list(listHash, signal) {
        const hash = FeedListHashSchema.parse(listHash);
        const response = await okResponse(
          fetcher,
          `${origin}${UTS_FEED_LIST_PATH_PREFIX}${hash}`,
          'application/json',
          signal
        );
        return new Uint8Array(await response.arrayBuffer());
      },
    },
    async bootstrap(signal) {
      const response = await okResponse(
        fetcher,
        `${origin}${UTS_BOOTSTRAP_PATH}`,
        'application/json',
        signal
      );
      const body = UtsBootstrapWireSchema.parse(await response.json());
      return {
        jwks: body.jwks,
        keyAges: body.key_ages,
        head: body.head,
        list: decodeBase64Url(body.list),
      };
    },
  };
}

/** Base64url without padding (RFC 4648 section 5), as the bootstrap body and list hashes use. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** The list hash of `bytes`: the base64url SHA-256 the head carries as `list_hash`. */
export async function feedListHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
