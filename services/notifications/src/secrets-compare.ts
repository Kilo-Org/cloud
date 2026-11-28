import { timingSafeEqual } from '@kilocode/encryption';
import type { BundleBinding, SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  readBundleSecret,
  readSecretsStoreSecret,
  type GuardRoute,
  type NotificationsSecretName,
  type NotificationsSecretsEnv,
  type NotificationsSecretsSource,
} from './secrets';
import { apnsPemBody, importApnsPrivateKey } from './lib/apns-live-activity';

/**
 * The comparison runs only when `WORKER_ENV` is `production` and `SECRETS_COMPARE_ENABLED` is
 * exactly `'true'`, under either source; both are checked before the request's execution context
 * or any value is read. It compares what the serving source holds with the other source through
 * the raw readers, so it never serves or refuses a request and never logs the `sts` read marker.
 */
export type SecretsCompareEnv = NotificationsSecretsEnv & {
  WORKER_ENV?: string;
  SECRETS_COMPARE_ENABLED?: string;
};

type ComparedName = Extract<
  NotificationsSecretName,
  'NOTIFICATIONS_APNS_PRIVATE_KEY' | 'NEXTAUTH_SECRET' | 'INTERNAL_API_SECRET'
>;

/** True only when the other source holds exactly the bytes the serving source holds. */
export type SecretsCompareResult = Record<ComparedName, boolean>;

const NOT_PROVEN: SecretsCompareResult = {
  NOTIFICATIONS_APNS_PRIVATE_KEY: false,
  NEXTAUTH_SECRET: false,
  INTERNAL_API_SECRET: false,
};

const COMPARED_NAMES = [
  'NOTIFICATIONS_APNS_PRIVATE_KEY',
  'NEXTAUTH_SECRET',
  'INTERNAL_API_SECRET',
] as const satisfies readonly ComparedName[];

/** Expo is compared on its own line, so its copy never changes the three names' result. */
const EXPO_NAME = 'NOTIFICATIONS_EXPO_ACCESS_TOKEN' satisfies NotificationsSecretName;

/** The guard that admitted or refused a request and the source serving it. */
export type CheckedRoute = { route: GuardRoute; source: NotificationsSecretsSource };

/**
 * A refused credential: the guard's own name and the expected value the guard already read. The
 * presented credential is never part of it.
 */
export type RefusedCheck = CheckedRoute & { secret: NotificationsSecretName; selected: string };

/**
 * The admitted-request events. The first carries the three names' booleans, the fixed route and
 * serving source, and the names whose two values were both read and differ. The second carries
 * Expo's own `match`, `mismatch` or `unproven`. The APNs key event below may follow the first.
 */
export const SECRETS_COMPARE_EVENT = 'notifications_secrets_compare';
export const SECRETS_COMPARE_EXPO_EVENT = 'notifications_secrets_compare_expo';

/**
 * The refused-request event: the guard's own name, its fixed route and serving source, and
 * `match`, `mismatch` or `unproven`.
 */
export const SECRETS_COMPARE_REFUSED_EVENT = 'notifications_secrets_compare_refused';

/**
 * Follows the admitted-request event only when both APNs key values were read and their bytes
 * differ. Fixed booleans say whether the two values are equal after `trim()`, after turning
 * literal `\n` sequences and CRLF into LF, and as the base64 body the signer decodes, and, per
 * source, whether the signer's own import accepts the value. `samePublicKey` compares the full
 * RFC 7638 thumbprints of the two public keys in memory; each source's thumbprint is logged only
 * as its first `APNS_THUMBPRINT_LOG_HEX` hex digits, `null` when the value does not import.
 */
export const SECRETS_COMPARE_APNS_EVENT = 'notifications_secrets_compare_apns';

export const APNS_THUMBPRINT_LOG_HEX = 12;

/**
 * A comparison settles within this time, inside the 30 s a request's `waitUntil` may run after its
 * response. The secrets client also gives up on a cold bundle within its own 25 s first-load
 * window; a comparison that has not settled reports nothing proven.
 */
export const SECRETS_COMPARE_DEADLINE_MS = 25_000;

type Comparison = 'match' | 'mismatch' | 'unproven';

type Lifetime = () => SecretsExecutionContext;

/**
 * Returns the isolate's two hooks. `admitted` compares the three names and Expo once per isolate,
 * after the first accepted request. `refused` compares only the guard's own name, once per isolate
 * and route, after a presented credential fails against a value the guard already read. Both run
 * under the request's `waitUntil`, never throw and never delay the caller. They log fixed fields
 * only; the APNs key event adds each source's shortened public-key thumbprint.
 * A disabled hook reads nothing, the execution context included; a context that cannot be read
 * or refuses the `waitUntil` registration skips the call and stays armed.
 */
export function createSecretsComparison() {
  let admittedStarted = false;
  const refusedStarted = new Set<GuardRoute>();
  const start = (
    env: SecretsCompareEnv,
    lifetime: Lifetime,
    work: (ctx: SecretsExecutionContext) => Promise<unknown>
  ) => {
    if (env.SECRETS_COMPARE_ENABLED !== 'true' || env.WORKER_ENV !== 'production') return false;
    // `waitUntil` registers a placeholder first: the comparison, and with it every read, starts
    // only once the request has accepted it, so a refused registration reads nothing.
    const registered = Promise.withResolvers<unknown>();
    let ctx: SecretsExecutionContext;
    try {
      ctx = lifetime();
      ctx.waitUntil(registered.promise);
    } catch {
      return false;
    }
    registered.resolve(work(ctx));
    return true;
  };
  return {
    admitted(env: SecretsCompareEnv, lifetime: Lifetime, checked: CheckedRoute): void {
      if (admittedStarted) return;
      admittedStarted = start(env, lifetime, ctx =>
        Promise.all([
          compareAdmitted(env, ctx, checked).then(({ line, apns }) => {
            console.log(SECRETS_COMPARE_EVENT, line);
            if (apns !== undefined) console.log(SECRETS_COMPARE_APNS_EVENT, apns);
          }),
          compareOne(env, ctx, checked, EXPO_NAME).then(line => {
            console.log(SECRETS_COMPARE_EXPO_EVENT, line);
          }),
        ])
      );
    },
    refused(env: SecretsCompareEnv, lifetime: Lifetime, checked: RefusedCheck): void {
      if (refusedStarted.has(checked.route)) return;
      const started = start(env, lifetime, async ctx => {
        const line = await compareOne(env, ctx, checked, checked.secret, checked.selected);
        console.log(SECRETS_COMPARE_REFUSED_EVENT, line);
      });
      if (started) refusedStarted.add(checked.route);
    },
  };
}

/** The isolate's hooks, called by the bearer check (auth.ts) and the internal routes (index.ts). */
export const secretsComparison = createSecretsComparison();

type AdmittedLine = SecretsCompareResult & CheckedRoute & { mismatched: ComparedName[] };

type ApnsKeyLine = CheckedRoute & {
  equalAfterTrim: boolean;
  equalAfterNewlines: boolean;
  equalPemBody: boolean;
  secretsStoreImportable: boolean;
  stsImportable: boolean;
  samePublicKey: boolean;
  secretsStoreThumbprint: string | null;
  stsThumbprint: string | null;
};

type Admitted = { line: AdmittedLine; apns?: ApnsKeyLine };

async function compareAdmitted(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  checked: CheckedRoute
): Promise<Admitted> {
  const unproven: Admitted = { line: { ...NOT_PROVEN, ...checked, mismatched: [] } };
  return withinDeadline(compareAll(env, ctx, checked), unproven);
}

async function compareAll(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  checked: CheckedRoute
): Promise<Admitted> {
  const [apnsPair, nextAuth, internalApi] = await Promise.all([
    readPair(env, ctx, checked.source, 'NOTIFICATIONS_APNS_PRIVATE_KEY'),
    compareName(env, ctx, checked.source, 'NEXTAUTH_SECRET'),
    compareName(env, ctx, checked.source, 'INTERNAL_API_SECRET'),
  ]);
  const apnsKey = compareBytes(apnsPair);
  const results: Record<ComparedName, Comparison> = {
    NOTIFICATIONS_APNS_PRIVATE_KEY: apnsKey,
    NEXTAUTH_SECRET: nextAuth,
    INTERNAL_API_SECRET: internalApi,
  };
  const line: AdmittedLine = {
    NOTIFICATIONS_APNS_PRIVATE_KEY: apnsKey === 'match',
    NEXTAUTH_SECRET: nextAuth === 'match',
    INTERNAL_API_SECRET: internalApi === 'match',
    route: checked.route,
    source: checked.source,
    mismatched: COMPARED_NAMES.filter(name => results[name] === 'mismatch'),
  };
  if (apnsPair === undefined || apnsKey !== 'mismatch') return { line };
  return { line, apns: await diagnoseApnsKey(apnsPair, checked) };
}

async function compareOne(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  checked: CheckedRoute,
  secret: NotificationsSecretName,
  selected?: string
) {
  const result = await withinDeadline(
    compareName(env, ctx, checked.source, secret, selected),
    'unproven'
  );
  return { route: checked.route, secret, source: checked.source, result };
}

async function withinDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  const deadline = Promise.withResolvers<T>();
  const handle = setTimeout(() => deadline.resolve(fallback), SECRETS_COMPARE_DEADLINE_MS);
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    clearTimeout(handle);
  }
}

type ReadPair = { served: string; other: string };

/**
 * Both values of `name`, or `undefined` when either is missing, empty or unreadable; the error
 * itself is dropped so no value reaches a log. `selected` is the value the guard already checked;
 * otherwise the serving source is read. Without the STS binding nothing is read.
 */
async function readPair(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  source: NotificationsSecretsSource,
  name: NotificationsSecretName,
  selected?: string
): Promise<ReadPair | undefined> {
  const binding = env.STS;
  if (binding === undefined) return undefined;
  const otherSource = source === 'sts' ? 'secrets-store' : 'sts';
  const [served, other] = await Promise.all([
    selected ?? readFrom(env, binding, ctx, source, name),
    readFrom(env, binding, ctx, otherSource, name),
  ]);
  if (!served || !other) return undefined;
  return { served, other };
}

/**
 * Exact bytes, never a parsed form: an APNs key copy that differs only in whitespace signs the
 * same, yet is a `mismatch` here. `diagnoseApnsKey` reports how such a key copy differs.
 */
function compareBytes(pair: ReadPair | undefined): Comparison {
  if (pair === undefined) return 'unproven';
  return timingSafeEqual(pair.served, pair.other) ? 'match' : 'mismatch';
}

async function compareName(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  source: NotificationsSecretsSource,
  name: NotificationsSecretName,
  selected?: string
): Promise<Comparison> {
  return compareBytes(await readPair(env, ctx, source, name, selected));
}

/** Works only on the two values already read: it reads nothing else and logs nothing itself. */
async function diagnoseApnsKey(
  { served, other }: ReadPair,
  checked: CheckedRoute
): Promise<ApnsKeyLine> {
  const [servedThumbprint, otherThumbprint] = await Promise.all([
    apnsThumbprint(served),
    apnsThumbprint(other),
  ]);
  const [secretsStore, sts] =
    checked.source === 'secrets-store'
      ? [servedThumbprint, otherThumbprint]
      : [otherThumbprint, servedThumbprint];
  return {
    route: checked.route,
    source: checked.source,
    equalAfterTrim: timingSafeEqual(served.trim(), other.trim()),
    equalAfterNewlines: timingSafeEqual(normalizeNewlines(served), normalizeNewlines(other)),
    equalPemBody: timingSafeEqual(apnsPemBody(served), apnsPemBody(other)),
    secretsStoreImportable: secretsStore !== undefined,
    stsImportable: sts !== undefined,
    samePublicKey:
      secretsStore !== undefined && sts !== undefined && timingSafeEqual(secretsStore, sts),
    secretsStoreThumbprint: secretsStore?.slice(0, APNS_THUMBPRINT_LOG_HEX) ?? null,
    stsThumbprint: sts?.slice(0, APNS_THUMBPRINT_LOG_HEX) ?? null,
  };
}

/** An escaped copy's literal `\n` sequences and CRLF line endings both become LF. */
function normalizeNewlines(value: string): string {
  return value.replaceAll('\\n', '\n').replaceAll('\r\n', '\n');
}

/**
 * The full hex RFC 7638 SHA-256 thumbprint of the public key the signer's own import yields, or
 * `undefined` when that import or the export fails; the error is dropped. Only the public `x` and
 * `y` enter the digest.
 */
async function apnsThumbprint(pem: string): Promise<string | undefined> {
  try {
    const key = await importApnsPrivateKey(pem, true);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    if (jwk instanceof ArrayBuffer || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      return undefined;
    }
    const members = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(members));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

async function readFrom(
  env: SecretsCompareEnv,
  binding: BundleBinding,
  ctx: SecretsExecutionContext,
  source: NotificationsSecretsSource,
  name: NotificationsSecretName
): Promise<string | undefined> {
  try {
    return source === 'sts'
      ? await readBundleSecret(binding, name, ctx)
      : await readSecretsStoreSecret(env, name);
  } catch {
    return undefined;
  }
}
