import 'server-only';
import { z } from 'zod';
import {
  GitHubIdentityPreconditionSchema,
  GitHubIdentityConflictError,
} from '@kilocode/db/github-identity';
import { encryptUserGithubTokenEnvelope } from './user-token-envelope';
import { storeGitHubIdentity } from './identity-store';

const InputSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(10_000)
      .regex(/^(?:gh[po]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)$/),
    expected: GitHubIdentityPreconditionSchema,
  })
  .strict();

// Fixed validation errors keep secret input out of error and tracing payloads.
export const ProvidedGitHubTokenInputSchema = z.unknown().transform((value, ctx) => {
  const parsed = InputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  ctx.addIssue({ code: 'custom', message: 'invalid_github_token_request' });
  return z.NEVER;
});

export class ProvidedGitHubTokenError extends Error {
  constructor(
    readonly reason:
      | 'invalid_token'
      | 'rate_limited'
      | 'temporarily_unavailable'
      | 'connection_conflict'
  ) {
    super(reason);
  }
}

const IdentitySchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().min(1).max(100),
});

async function readIdentity(response: Response) {
  if (!response.body) throw new ProvidedGitHubTokenError('temporarily_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 64 * 1024) throw new ProvidedGitHubTokenError('temporarily_unavailable');
      chunks.push(value);
    }
    const parsed = IdentitySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed.success) throw new ProvidedGitHubTokenError('temporarily_unavailable');
    return parsed.data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function authenticateToken(token: string) {
  const response = await fetch('https://api.github.com/user', {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Kilo-GitHub-Identity',
    },
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new ProvidedGitHubTokenError('invalid_token');
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')))
    ) {
      throw new ProvidedGitHubTokenError('rate_limited');
    }
    throw new ProvidedGitHubTokenError('temporarily_unavailable');
  }
  const user = await readIdentity(response);
  const expiryHeader = response.headers.get('github-authentication-token-expiration');
  const expiry = expiryHeader ? Date.parse(expiryHeader) : NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now())
    throw new ProvidedGitHubTokenError('invalid_token');
  return { user, expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null };
}

export async function connectProvidedGitHubToken(
  userId: string,
  input: z.infer<typeof ProvidedGitHubTokenInputSchema>
) {
  try {
    const { user, expiresAt } = await authenticateToken(input.token);
    return await storeGitHubIdentity(
      {
        kilo_user_id: userId,
        github_app_type: 'standard',
        credential_source: 'provided_token',
        github_user_id: user.id.toString(),
        github_login: user.login,
        access_token_encrypted: encryptUserGithubTokenEnvelope(input.token, {
          kiloUserId: userId,
          githubUserId: user.id.toString(),
          tokenType: 'access',
        }),
        access_token_expires_at: expiresAt,
        refresh_token_encrypted: null,
        refresh_token_expires_at: null,
      },
      input.expected
    );
  } catch (error) {
    if (error instanceof ProvidedGitHubTokenError) throw error;
    if (error instanceof GitHubIdentityConflictError)
      throw new ProvidedGitHubTokenError('connection_conflict');
    // Do not retain a fetch, encryption, or persistence error with secret context.
    throw new ProvidedGitHubTokenError('temporarily_unavailable');
  }
}
