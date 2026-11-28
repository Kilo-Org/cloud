import { z } from 'zod';
import { REPOSITORY } from './config';

/**
 * Read-only GitHub calls of the proxy (contract §5 steps 3-5), with an installation token of the
 * `kilo-migration-proxy` App: minted for this one repository with read permissions only, and
 * cached until 10 minutes before it expires. Every call that cannot answer now (a rate limit, a
 * 5xx, a network failure, a refused token) throws `GithubUnavailableError`; a later alarm retries.
 */

/** GitHub's REST API; only the local stack (`development`) points elsewhere, at a fake. */
export const GITHUB_API = 'https://api.github.com';
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
/** No PR has more reviews than this in practice; the walk stops there rather than loop. */
const MAX_REVIEW_PAGES = 30;

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export class GithubUnavailableError extends Error {
  /** When GitHub said to come back (rate limit reset or Retry-After), in epoch ms. */
  readonly retryAt: number | null;
  constructor(what: string, retryAt: number | null = null) {
    super(`github unavailable: ${what}`);
    this.name = 'GithubUnavailableError';
    this.retryAt = retryAt;
  }
}

export type CompareStatus = 'identical' | 'ahead' | 'behind' | 'diverged' | 'not_found';

export type TreeEntry = { name: string; type: 'blob' | 'tree' | 'commit'; sha: string };

export type PullSummary = {
  number: number;
  mergedAt: string | null;
  baseRef: string;
  authorId: number;
};

export type Review = {
  userId: number;
  state: string;
  commitId: string | null;
};

export type GithubClient = {
  /** `compare/{base}...{head}`'s status: `ahead` means head is a descendant of base. */
  compare(base: string, head: string): Promise<CompareStatus>;
  /** One level of a tree; a commit sha names its root tree. Null when it does not exist. */
  tree(sha: string): Promise<TreeEntry[] | null>;
  blob(sha: string): Promise<Uint8Array>;
  /** The newest commit on `sha`'s history that changed `path`. */
  lastCommitTouching(sha: string, path: string): Promise<string | null>;
  pullsOfCommit(commit: string): Promise<PullSummary[]>;
  /** Every review of a PR, oldest first. */
  reviews(pr: number): Promise<Review[]>;
  /** The blob at `path` in commit `ref`, or null when the path is absent there. */
  blobAt(ref: string, path: string): Promise<string | null>;
};

export type GithubAppCredentials = {
  appId: string;
  installationId: string;
  apiUrl: string;
  /** The App's PEM private key (PKCS#1, as GitHub issues it, or PKCS#8), read when needed. */
  privateKey: () => Promise<string>;
};

const CompareSchema = z.object({
  status: z.enum(['identical', 'ahead', 'behind', 'diverged']),
});
const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({ path: z.string(), type: z.enum(['blob', 'tree', 'commit']), sha: z.string() })
  ),
});
const BlobSchema = z.object({ encoding: z.literal('base64'), content: z.string() });
const CommitListSchema = z.array(z.object({ sha: z.string() }));
const PullListSchema = z.array(
  z.object({
    number: z.number().int(),
    merged_at: z.string().nullable(),
    base: z.object({ ref: z.string() }),
    user: z.object({ id: z.number().int() }).nullable(),
  })
);
const ReviewListSchema = z.array(
  z.object({
    user: z.object({ id: z.number().int() }).nullable(),
    state: z.string(),
    commit_id: z.string().nullable(),
  })
);
const ContentsSchema = z.union([
  z.object({ type: z.string(), sha: z.string() }),
  z.array(z.unknown()),
]);
const TokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });
const ErrorBodySchema = z.object({
  message: z.string().optional(),
  documentation_url: z.string().optional(),
});

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const header = [tag, ...derLength(content.byteLength)];
  const out = new Uint8Array(header.length + content.byteLength);
  out.set(header);
  out.set(content, header.length);
  return out;
}

/** `AlgorithmIdentifier { rsaEncryption, NULL }`. */
const RSA_ENCRYPTION = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** The PKCS#8 DER of a PEM key; a PKCS#1 `RSA PRIVATE KEY` is wrapped in a `PrivateKeyInfo`. */
export function pkcs8Der(pem: string): Uint8Array {
  const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(body), char => char.charCodeAt(0));
  if (!pkcs1) return bytes;
  const version = [0x02, 0x01, 0x00];
  const key = der(0x04, bytes);
  const content = new Uint8Array(version.length + RSA_ENCRYPTION.length + key.byteLength);
  content.set(version);
  content.set(RSA_ENCRYPTION, version.length);
  content.set(key, version.length + RSA_ENCRYPTION.length);
  return der(0x30, content);
}

/** An RS256 App JWT: issued a minute back for clock skew, valid 9 minutes. */
async function appJwt(appId: string, pem: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const issuedAt = Math.floor(now / 1000) - 60;
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: appId })
  )}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** A rate-limit answer (403/429 with no remaining quota, or `Retry-After`) and its reset time. */
function rateLimitedUntil(response: Response, now: number): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^[0-9]+$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60_000;
  }
  return null;
}

function segments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Each GitHub call, body included, gets this long before it counts as a network failure. */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

type GithubOp =
  | 'token'
  | 'compare'
  | 'tree'
  | 'blob'
  | 'commits'
  | 'pulls'
  | 'reviews'
  | 'contents';

/** What GitHub said about a failed call. Never a header that carries a credential. */
type GithubFailure = {
  status: number | null;
  githubMessage: string | null;
  documentationUrl: string | null;
  retryAfter: string | null;
  rateLimitRemaining: string | null;
  timedOut: boolean;
};

const NO_ANSWER: GithubFailure = {
  status: null,
  githubMessage: null,
  documentationUrl: null,
  retryAfter: null,
  rateLimitRemaining: null,
  timedOut: false,
};
const LOGGED_TEXT_LIMIT = 300;

async function failureOf(response: Response): Promise<GithubFailure> {
  let errorBody: z.infer<typeof ErrorBodySchema> = {};
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) errorBody = parsed.data;
  } catch {
    // Not JSON, or cut off by the timeout: the status and headers still say what happened.
  }
  return {
    status: response.status,
    githubMessage: errorBody.message?.slice(0, LOGGED_TEXT_LIMIT) ?? null,
    documentationUrl: errorBody.documentation_url?.slice(0, LOGGED_TEXT_LIMIT) ?? null,
    retryAfter: response.headers.get('retry-after'),
    rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
    timedOut: false,
  };
}

/** Logs one `github_call_failed` line, so Workers Logs shows why GitHub counts as unavailable. */
function unavailable(
  op: GithubOp,
  reason: string,
  failure: GithubFailure = NO_ANSWER,
  retryAt: number | null = null
): GithubUnavailableError {
  console.warn({ event: 'github_call_failed', op, reason, ...failure });
  return new GithubUnavailableError(reason, retryAt);
}

/**
 * A GitHub answer in the shape GitHub documents, else GitHub counts as unavailable: a malformed
 * tree, blob, review or compare body stalls the step like a 5xx, and is never a server error.
 */
function answer<T>(op: GithubOp, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unavailable(op, 'malformed answer');
  return parsed.data;
}

export function createGithubClient(
  credentials: GithubAppCredentials,
  fetcher: GithubFetch,
  now: () => number = Date.now,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS
): GithubClient {
  let cached: { token: string; expiresAt: number } | null = null;
  const API = credentials.apiUrl;
  const REPO = `${API}/repos/${REPOSITORY.fullName}`;

  const headers = (authorization: string) => ({
    Accept: 'application/vnd.github+json',
    Authorization: authorization,
    'User-Agent': 'kilo-migration-proxy',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  const send = async (op: GithubOp, url: string, init: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw unavailable(op, 'network', { ...NO_ANSWER, timedOut });
    }
    const limited = rateLimitedUntil(response, now());
    if (limited !== null) {
      throw unavailable(op, 'rate limited', await failureOf(response), limited);
    }
    return response;
  };

  /** The JSON body; a body cut off by the timeout is a network failure too. */
  const body = async (op: GithubOp, response: Response): Promise<unknown> => {
    try {
      return await response.json();
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw unavailable(op, 'network', { ...NO_ANSWER, status: response.status, timedOut });
    }
  };

  const token = async (): Promise<string> => {
    if (cached !== null && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;
    let pem: string;
    try {
      pem = await credentials.privateKey();
    } catch {
      throw unavailable('token', 'app key unavailable');
    }
    const jwt = await appJwt(credentials.appId, pem, now());
    const response = await send(
      'token',
      `${API}/app/installations/${credentials.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: { ...headers(`Bearer ${jwt}`), 'Content-Type': 'application/json' },
        // Pull requests: read is what the review and commit-to-PR endpoints need (§5 step 5).
        body: JSON.stringify({
          repository_ids: [Number(REPOSITORY.id)],
          permissions: { contents: 'read', pull_requests: 'read' },
        }),
      }
    );
    if (response.status !== 201) {
      throw unavailable('token', `token ${response.status}`, await failureOf(response));
    }
    const parsed = answer('token', TokenSchema, await body('token', response));
    cached = { token: parsed.token, expiresAt: Date.parse(parsed.expires_at) };
    return parsed.token;
  };

  /** GET with the installation token; null on 404 (and on 422 where GitHub means "no such ref"). */
  const get = async (
    op: GithubOp,
    url: string,
    notFound: readonly number[] = [404]
  ): Promise<unknown> => {
    const response = await send(op, url, { headers: headers(`token ${await token()}`) });
    if (notFound.includes(response.status)) return null;
    if (!response.ok) {
      if (response.status === 401) cached = null;
      throw unavailable(op, `GET ${response.status}`, await failureOf(response));
    }
    return await body(op, response);
  };

  return {
    async compare(base, head) {
      const body = await get('compare', `${REPO}/compare/${base}...${head}?per_page=1`, [404, 422]);
      return body === null ? 'not_found' : answer('compare', CompareSchema, body).status;
    },
    async tree(sha) {
      const body = await get('tree', `${REPO}/git/trees/${sha}`, [404, 422]);
      if (body === null) return null;
      const parsed = answer('tree', TreeSchema, body);
      if (parsed.truncated) throw unavailable('tree', 'tree truncated');
      return parsed.tree.map(entry => ({ name: entry.path, type: entry.type, sha: entry.sha }));
    },
    async blob(sha) {
      const body = await get('blob', `${REPO}/git/blobs/${sha}`, []);
      const parsed = answer('blob', BlobSchema, body);
      return Uint8Array.from(atob(parsed.content.replace(/\s+/g, '')), char => char.charCodeAt(0));
    },
    async lastCommitTouching(sha, path) {
      const query = new URLSearchParams({ sha, path, per_page: '1' });
      const body = await get('commits', `${REPO}/commits?${query.toString()}`, [404, 422]);
      return body === null ? null : (answer('commits', CommitListSchema, body)[0]?.sha ?? null);
    },
    async pullsOfCommit(commit) {
      const body = await get(
        'pulls',
        `${REPO}/commits/${commit}/pulls?per_page=${PAGE_SIZE}`,
        [404, 422]
      );
      if (body === null) return [];
      return answer('pulls', PullListSchema, body).map(pull => ({
        number: pull.number,
        mergedAt: pull.merged_at,
        baseRef: pull.base.ref,
        authorId: pull.user?.id ?? -1,
      }));
    },
    async reviews(pr) {
      const reviews: Review[] = [];
      for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
        const body = await get(
          'reviews',
          `${REPO}/pulls/${pr}/reviews?per_page=${PAGE_SIZE}&page=${page}`,
          []
        );
        const batch = answer('reviews', ReviewListSchema, body);
        for (const review of batch) {
          if (review.user === null) continue;
          reviews.push({ userId: review.user.id, state: review.state, commitId: review.commit_id });
        }
        if (batch.length < PAGE_SIZE) return reviews;
      }
      throw unavailable('reviews', 'too many review pages');
    },
    async blobAt(ref, path) {
      const body = await get('contents', `${REPO}/contents/${segments(path)}?ref=${ref}`);
      if (body === null) return null;
      const parsed = answer('contents', ContentsSchema, body);
      return Array.isArray(parsed) || parsed.type !== 'file' ? null : parsed.sha;
    },
  };
}

/** git's blob id: `sha1("blob <len>\0" + bytes)`, hex. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const joined = new Uint8Array(header.byteLength + bytes.byteLength);
  joined.set(header);
  joined.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', joined));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
