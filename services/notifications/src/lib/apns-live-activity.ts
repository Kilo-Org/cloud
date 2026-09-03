/**
 * Token-based APNs client for Live Activity start, update, and end pushes.
 * Pure: every network hop goes through the injected `fetchFn` so unit tests
 * substitute a fake. Never logs a device token or the private key.
 */

export type ApnsCredentials = {
  teamId: string;
  keyId: string;
  /** PKCS#8 ES256 `.p8` contents, PEM-armoured. */
  privateKeyPem: string;
  /** iOS app bundle id (e.g. `com.kilocode.kiloapp`). */
  topic: string;
};

export type LiveActivityEvent = 'start' | 'update' | 'end';

// ActivityKit controls Lock Screen dismissal, not Dynamic Island retention.
const TERMINAL_SECONDS = 8;

const APNS_BASE_URL = 'https://api.push.apple.com';
const APNS_KEY_PREFIX = '-----BEGIN PRIVATE KEY-----';
const APNS_KEY_SUFFIX = '-----END PRIVATE KEY-----';

/**
 * The `ActivityAttributes` type name the widget extension declares. Push-to-start
 * uses this as `attributes-type` so iOS knows which activity to create.
 */
const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'LiveActivityAttributes';

/**
 * Apple requires an alert on every push-to-start payload; a start without one
 * is rejected. Only Apple Watch renders the title and body — iPhone and iPad
 * show the Live Activity itself. The caller resolves the copy, so this module
 * stays a pure transport with no catalog dependency.
 */
export type LiveActivityAlert = { title: string; body: string };

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(APNS_KEY_PREFIX, '').replace(APNS_KEY_SUFFIX, '').replace(/\s/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Sign a short-lived ES256 APNs provider token (JWT). */
export async function signApnsJwt(
  credentials: ApnsCredentials,
  nowSeconds: number
): Promise<string> {
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }))
  );
  const claims = base64Url(
    encoder.encode(JSON.stringify({ iss: credentials.teamId, iat: nowSeconds }))
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(credentials.privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(signingInput)
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * Build the HTTP request shape for one Live Activity APNs push. Live Activity
 * pushes use `apns-push-type: liveactivity`, `apns-priority: 10`, and the
 * `.push-type.liveactivity` topic suffix. The `timestamp` (Unix seconds) is
 * what lets iOS discard an older revision that arrives late.
 */
export function buildLiveActivityApnsRequest(
  params: {
    token: string;
    contentState: Record<string, unknown>;
    credentials: ApnsCredentials;
    authorizationJwt: string;
    timestampSeconds: number;
  } & (
    | { event: 'start'; startAlert: LiveActivityAlert }
    | { event: 'update' }
    | { event: 'end'; dismissalDateSeconds: number }
  )
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${APNS_BASE_URL}/3/device/${params.token}`,
    headers: {
      authorization: `bearer ${params.authorizationJwt}`,
      'apns-topic': `${params.credentials.topic}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: {
        timestamp: params.timestampSeconds,
        event: params.event,
        // Push-to-start must name the attributes type and supply its values so
        // iOS can create the activity. Updates only replace the content-state.
        ...(params.event === 'start'
          ? {
              'attributes-type': LIVE_ACTIVITY_ATTRIBUTES_TYPE,
              attributes: {},
              alert: params.startAlert,
            }
          : {}),
        'content-state': params.contentState,
        ...(params.event === 'end' ? { 'dismissal-date': params.dismissalDateSeconds } : {}),
      },
    }),
  };
}

export type LiveActivityApnsSendResult = {
  attempted: number;
  ok: number;
  failed: number;
};

/** Send one Live Activity push per token in parallel. */
export async function sendLiveActivityApns(params: {
  credentials: ApnsCredentials;
  tokens: readonly { token: string; event: LiveActivityEvent }[];
  contentState: Record<string, unknown>;
  /** Required by APNs on a start; resolved by the caller in the user's locale. */
  startAlert: LiveActivityAlert;
  nowSeconds: number;
  /** Snapshot ordering time, independent of the provider token's signing time. */
  timestampSeconds?: number;
  /** Recheck the durable generation after signing, before each request. */
  isCurrent?: () => Promise<boolean>;
  /** Persist terminal intent after signing, before the end can reach ActivityKit. */
  beforeEnd?: (token: string) => Promise<boolean>;
  /** Retire successful ends by registration identity, even after a newer generation. */
  onEnded?: (token: string) => Promise<void>;
  /** Release only an explicitly rejected end; a lost response leaves delivery uncertain. */
  onEndRejected?: (token: string) => Promise<void>;
  fetchFn?: typeof fetch;
}): Promise<LiveActivityApnsSendResult> {
  if (params.tokens.length === 0) {
    return { attempted: 0, ok: 0, failed: 0 };
  }

  const authorizationJwt = await signApnsJwt(params.credentials, params.nowSeconds);
  const fetchFn = params.fetchFn ?? fetch;

  const results = await Promise.allSettled(
    params.tokens.map(async ({ token, event }) => {
      if (params.isCurrent && !(await params.isCurrent())) return false;
      if (event === 'end' && params.beforeEnd && !(await params.beforeEnd(token))) return false;
      const request = buildLiveActivityApnsRequest({
        token,
        ...(event === 'end'
          ? { event, dismissalDateSeconds: Math.floor(Date.now() / 1000) + TERMINAL_SECONDS }
          : event === 'start'
            ? { event, startAlert: params.startAlert }
            : { event }),
        contentState: params.contentState,
        credentials: params.credentials,
        authorizationJwt,
        timestampSeconds: params.timestampSeconds ?? params.nowSeconds,
      });
      const response = await fetchFn(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      });
      if (!response.ok) {
        if (event === 'end') {
          // A 410 confirms an inactive target, not a live activity that can recover.
          if (response.status === 410) await params.onEnded?.(token);
          else await params.onEndRejected?.(token);
        }
        throw new Error(`APNs rejected the push with status ${response.status}`);
      }
      if (event === 'end') {
        await params.onEnded?.(token);
      }
      return true;
    })
  );

  const ok = results.filter(result => result.status === 'fulfilled' && result.value).length;
  const failed = results.filter(result => result.status === 'rejected').length;
  return { attempted: ok + failed, ok, failed };
}
