/**
 * Deployed-profile auth contract for the E2E driver.
 *
 * The deployed driver does not mint JWTs: it presents a real ordinary personal
 * Kilo API token (the `generateApiToken` family) as a bearer and fetches stream
 * tickets from the live backend. This module owns that decision and fails closed
 * before any request when the supplied token is not an ordinary personal token.
 *
 * The token pre-check decodes the JWT payload WITHOUT verifying the signature.
 * The Worker remains the signature-verification authority; this only rejects
 * policy-bearing/runtime tokens early with a diagnostic, because those take the
 * runtime-authorization path and fail admission against the fake catalog URL.
 */

import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import jwt from 'jsonwebtoken';
import { LOCAL_FAKE_LLM_ADMIN_TOKEN } from './fake-llm-admin.js';
import { requireE2eInternalSecret } from './e2e-internal-secret.js';

export type DeployedIdentity = { userId: string; email: string | undefined };
export type DeployedAuth = { token: string; identity: DeployedIdentity };
/**
 * Raw auth-file shape: `fakeLlmAdminToken` and `e2eInternalApiSecret` are
 * optional and not yet validated.
 */
export type DeployedAuthFile = DeployedAuth & {
  fakeLlmAdminToken: string | undefined;
  e2eInternalApiSecret: string | undefined;
};

const ORDINARY_TOKEN_REQUIREMENT =
  'an ordinary personal Kilo API token (the generateApiToken family), not a session/control token, organization token, or delegated/runtime token';

/** Claims that mark a policy-bearing/runtime token. Mirrors the session runtime branch. */
const REJECTED_POLICY_CLAIMS = [
  'aud',
  'runtimeAdmission',
  'runtimeAuthorization',
  'tokenPurpose',
  'credentialExchange',
  'organizationId',
  'organizationRole',
] as const;

const BARE_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function fail(detail: string): never {
  throw new Error(`Refusing token: ${detail}. Expected ${ORDINARY_TOKEN_REQUIREMENT}.`);
}

/**
 * Decode a JWT payload without trusting the signature and reject anything that
 * is not an ordinary personal API token.
 */
export function decodeOrdinaryPersonalToken(token: string): { kiloUserId: string } {
  if (typeof token !== 'string' || !BARE_JWT_PATTERN.test(token)) {
    return fail(
      'the value is not a bare three-segment JWT (a Bearer-prefixed, quoted, serialised, or truncated value was supplied)'
    );
  }

  let payload: unknown;
  try {
    payload = jwt.decode(token);
  } catch {
    return fail('the JWT payload could not be decoded');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail('the JWT payload is not a decodable object');
  }

  const claims = payload as Record<string, unknown>;
  for (const claim of REJECTED_POLICY_CLAIMS) {
    if (Object.prototype.hasOwnProperty.call(claims, claim)) {
      return fail(`the payload carries the policy claim "${claim}"`);
    }
  }

  const kiloUserId = claims.kiloUserId;
  if (typeof kiloUserId !== 'string' || kiloUserId.length === 0) {
    return fail('the payload is missing a non-empty string "kiloUserId"');
  }
  const apiTokenPepper = claims.apiTokenPepper;
  if (apiTokenPepper === undefined) {
    return fail('the "apiTokenPepper" claim is absent (an explicit null is accepted)');
  }

  return { kiloUserId };
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  filePath: string
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Deployed auth file ${filePath} is missing a non-empty string "${field}"`);
  }
  return value;
}

/** An omitted field is `undefined`; a present field must be a non-empty string. */
function optionalStringField(
  record: Record<string, unknown>,
  field: string,
  filePath: string
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Deployed auth file ${filePath}: "${field}" must be a non-empty string when present`
    );
  }
  return value;
}

/**
 * Load and validate the deployed auth file: JSON
 * `{ token, userId?, email?, fakeLlmAdminToken? }` in a mode-600 file. This is the
 * single read, so the admin token and the Kilo identity come from the same
 * contents. `userId` and `email` are optional: an omitted `userId` is derived
 * from the decoded token and an omitted `email` yields `undefined`. Never prints
 * the token.
 */
export function loadDeployedAuthFile(filePath: string): DeployedAuthFile {
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read deployed auth file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let mode: number;
  try {
    mode = statSync(filePath).mode;
  } catch (err) {
    throw new Error(
      `Failed to stat deployed auth file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Refusing deployed auth file ${filePath}: permissions are group/other-accessible. Run chmod 600 ${filePath}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Deployed auth file ${filePath} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Deployed auth file ${filePath} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const token = requireStringField(record, 'token', filePath);
  const fileUserId = optionalStringField(record, 'userId', filePath);
  const email = optionalStringField(record, 'email', filePath);

  const rawFakeLlmAdminToken = record.fakeLlmAdminToken;
  if (rawFakeLlmAdminToken !== undefined && typeof rawFakeLlmAdminToken !== 'string') {
    throw new Error(
      `Deployed auth file ${filePath}: "fakeLlmAdminToken" must be a string when present`
    );
  }
  const fakeLlmAdminToken = rawFakeLlmAdminToken;

  const rawE2eInternalApiSecret = record.e2eInternalApiSecret;
  if (rawE2eInternalApiSecret !== undefined && typeof rawE2eInternalApiSecret !== 'string') {
    throw new Error(
      `Deployed auth file ${filePath}: "e2eInternalApiSecret" must be a string when present`
    );
  }
  const e2eInternalApiSecret = rawE2eInternalApiSecret;

  const decoded = decodeOrdinaryPersonalToken(token);
  if (fileUserId !== undefined && decoded.kiloUserId !== fileUserId) {
    throw new Error(
      `Deployed auth file ${filePath}: decoded kiloUserId does not match the file "userId"`
    );
  }

  return {
    token,
    identity: { userId: fileUserId ?? decoded.kiloUserId, email },
    fakeLlmAdminToken,
    e2eInternalApiSecret,
  };
}

function requireHttpsUrl(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Deployed profile requires env var ${key}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an https:// URL, but it is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${key} must be an https:// URL`);
  }
  return value;
}

/**
 * Validate an already-selected fake-LLM `/test/*` admin bearer. It never
 * consults the environment or chooses a source: `assertDeployedProfileEnv` owns
 * precedence and passes the source label for the diagnostic. It rejects rather
 * than trims a whitespace-padded value and refuses the insecure development
 * default, so the deployed profile can never present the local zero-config
 * credential. It is never printed.
 */
function validateFakeLlmAdminToken(value: string, source: string): string {
  if (value !== value.trim()) {
    throw new Error(
      `The fake-LLM admin token from ${source} must not have leading or trailing whitespace; the whitespace-padded value is rejected, not trimmed`
    );
  }
  if (value === LOCAL_FAKE_LLM_ADMIN_TOKEN) {
    throw new Error(
      `The fake-LLM admin token from ${source} must not be the insecure development default "${LOCAL_FAKE_LLM_ADMIN_TOKEN}"`
    );
  }
  return value;
}

/**
 * Validate an already-selected e2e internal API secret with the shared rules
 * (`requireE2eInternalSecret`), so the driver, the renderer and the deploy
 * script cannot disagree about what is acceptable. Like the fake-LLM admin
 * token it rejects rather than trims a whitespace-padded value and refuses the
 * insecure development default; `source` names where the value came from for
 * the diagnostic. It is never printed.
 */
function validateE2eInternalSecret(value: string, source: string): string {
  return requireE2eInternalSecret(value, `The e2e internal API secret from ${source}`);
}

/**
 * A non-empty string counts as present; an empty string counts as unset
 * (GitHub Actions yields `''` for unset secrets). A whitespace-padded value is
 * present but invalid and is rejected downstream, not trimmed.
 */
function present(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read and validate the deployed-profile environment. Called by
 * `bootstrapDeployedProfile`, which the deployed entry point calls — never
 * top-level validation (see the service AGENTS.md).
 *
 * This is the single owner of source precedence:
 * - the user token comes from a non-empty `E2E_USER_TOKEN`, else the `token`
 *   field of the file named by `E2E_AUTH_FILE`, else it fails naming both;
 * - the admin token keeps its `FAKE_LLM_ADMIN_TOKEN` → file `fakeLlmAdminToken`
 *   → fail precedence;
 * - the e2e internal API secret keeps the same shape:
 *   `E2E_INTERNAL_API_SECRET` → file `e2eInternalApiSecret` → fail naming both.
 *
 * The auth file is read at most once and only when a source actually needs it.
 * This path never reads `.dev.vars`, root env files, or Postgres, and never
 * mints a valid credential.
 */
export function assertDeployedProfileEnv(env: Record<string, string | undefined> = process.env): {
  workerUrl: string;
  backendUrl: string;
  fakeLlmUrl: string;
  authFile: string | undefined;
  fakeLlmAdminToken: string;
  e2eInternalApiSecret: string;
  auth: DeployedAuth;
} {
  const workerUrl = requireHttpsUrl(env, 'WORKER_URL');
  const backendUrl = requireHttpsUrl(env, 'E2E_BACKEND_URL');
  const fakeLlmUrl = requireHttpsUrl(env, 'FAKE_LLM_URL');

  const envUserToken = present(env.E2E_USER_TOKEN);
  const envAdminToken = present(env.FAKE_LLM_ADMIN_TOKEN);
  const authFilePath = present(env.E2E_AUTH_FILE);

  let loaded: DeployedAuthFile | undefined;
  const loadAuthFileOnce = (): DeployedAuthFile | undefined => {
    if (loaded !== undefined) return loaded;
    if (authFilePath === undefined) return undefined;
    loaded = loadDeployedAuthFile(authFilePath);
    return loaded;
  };

  let auth: DeployedAuth;
  if (envUserToken !== undefined) {
    const decoded = decodeOrdinaryPersonalToken(envUserToken);
    auth = {
      token: envUserToken,
      identity: { userId: decoded.kiloUserId, email: undefined },
    };
  } else {
    const fromFile = loadAuthFileOnce();
    if (fromFile === undefined) {
      throw new Error(
        'Deployed profile requires a user token: set E2E_USER_TOKEN, or set E2E_AUTH_FILE to a mode-600 JSON file with a "token" field'
      );
    }
    auth = { token: fromFile.token, identity: fromFile.identity };
  }

  const fileAdminToken =
    envAdminToken === undefined ? loadAuthFileOnce()?.fakeLlmAdminToken : undefined;
  const selectedAdminToken = present(envAdminToken ?? fileAdminToken);
  if (selectedAdminToken === undefined) {
    const authFile = env.E2E_AUTH_FILE ?? '<E2E_AUTH_FILE>';
    throw new Error(
      `Deployed profile requires a fake-LLM admin token: set FAKE_LLM_ADMIN_TOKEN, or set the "fakeLlmAdminToken" field of the auth file ${authFile}`
    );
  }
  const adminTokenSource =
    envAdminToken !== undefined
      ? 'FAKE_LLM_ADMIN_TOKEN'
      : 'the "fakeLlmAdminToken" field of the auth file';
  const fakeLlmAdminToken = validateFakeLlmAdminToken(selectedAdminToken, adminTokenSource);

  const envInternalSecret = present(env.E2E_INTERNAL_API_SECRET);
  const fileInternalSecret =
    envInternalSecret === undefined ? loadAuthFileOnce()?.e2eInternalApiSecret : undefined;
  const selectedInternalSecret = present(envInternalSecret ?? fileInternalSecret);
  if (selectedInternalSecret === undefined) {
    const authFile = env.E2E_AUTH_FILE ?? '<E2E_AUTH_FILE>';
    throw new Error(
      `Deployed profile requires an e2e internal API secret: set E2E_INTERNAL_API_SECRET, or set the "e2eInternalApiSecret" field of the auth file ${authFile}`
    );
  }
  const internalSecretSource =
    envInternalSecret !== undefined
      ? 'E2E_INTERNAL_API_SECRET'
      : 'the "e2eInternalApiSecret" field of the auth file';
  const e2eInternalApiSecret = validateE2eInternalSecret(
    selectedInternalSecret,
    internalSecretSource
  );

  return {
    workerUrl,
    backendUrl,
    fakeLlmUrl,
    authFile: loaded === undefined ? undefined : authFilePath,
    fakeLlmAdminToken,
    e2eInternalApiSecret,
    auth,
  };
}

/**
 * Publish the already-resolved admin bearer into the environment the control
 * helpers read (`resolveFakeAdminToken` reads `FAKE_LLM_ADMIN_TOKEN` only). A
 * setter only: it does not re-derive precedence, re-read the auth file, or
 * validate. Never prints the token.
 */
export function publishFakeAdminToken(
  token: string,
  env: Record<string, string | undefined> = process.env
): void {
  env.FAKE_LLM_ADMIN_TOKEN = token;
}

/**
 * Publish the already-resolved e2e internal API secret into the environment the
 * local resolver reads (`resolveE2eInternalSecret` reads
 * `E2E_INTERNAL_API_SECRET` only). A setter only: it does not re-derive
 * precedence, re-read the auth file, or validate. Never prints the secret.
 */
export function publishE2eInternalSecret(
  secret: string,
  env: Record<string, string | undefined> = process.env
): void {
  env.E2E_INTERNAL_API_SECRET = secret;
}

/**
 * The single publication path for a deployed run: validate/resolve once via
 * `assertDeployedProfileEnv`, publish the resolved admin bearer so the existing
 * control helpers consume it, and publish the resolved e2e internal secret so
 * the driver and the surface agree on one value. Returns the validated values.
 * Called by `runDeployed` before any scenario runs.
 */
export function bootstrapDeployedProfile(
  env: Record<string, string | undefined> = process.env
): ReturnType<typeof assertDeployedProfileEnv> {
  const resolved = assertDeployedProfileEnv(env);
  publishFakeAdminToken(resolved.fakeLlmAdminToken, env);
  publishE2eInternalSecret(resolved.e2eInternalApiSecret, env);
  return resolved;
}

/**
 * Fetch a short-lived stream ticket from the live backend. Never prints the token.
 */
export async function fetchStreamTicket(input: {
  backendUrl: string;
  token: string;
  sessionId: string;
}): Promise<string> {
  const url = `${input.backendUrl.replace(/\/$/, '')}/api/cloud-agent-next/sessions/stream-ticket`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({ cloudAgentSessionId: input.sessionId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch stream ticket: ${response.status} ${response.statusText}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Stream ticket response was not valid JSON');
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('Stream ticket response was not a JSON object');
  }
  const ticket = (body as Record<string, unknown>).ticket;
  if (typeof ticket !== 'string' || ticket.length === 0) {
    throw new Error('Stream ticket response did not contain a non-empty string "ticket"');
  }
  return ticket;
}
