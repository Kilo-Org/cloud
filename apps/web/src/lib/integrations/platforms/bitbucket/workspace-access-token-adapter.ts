import 'server-only';

import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_SCOPE_LABELS,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
  getMissingBitbucketWorkspaceAccessTokenScopes,
  hasBitbucketAccessTokenFamilyPrefix,
  type BitbucketWorkspaceAccessTokenRequiredScope,
  isValidBitbucketRepositoryPaginationUrl,
  normalizeBitbucketWorkspaceAccessTokenScopes,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { z } from 'zod';

const BITBUCKET_API_ORIGIN = 'https://api.bitbucket.org';
const BITBUCKET_PROVIDER_TIMEOUT_MS = 10_000;
const BITBUCKET_WORKSPACE_DISCOVERY_PAGE_LENGTH = 2;
const BITBUCKET_REPOSITORY_PAGE_LENGTH = 50;
const BITBUCKET_MAX_REPOSITORY_PAGES = 100;
const BITBUCKET_MAX_REPOSITORY_ITEMS = 5000;
const BITBUCKET_MAX_RESPONSE_BYTES = 1_000_000;
const BITBUCKET_MAX_ACCESS_TOKEN_LENGTH = 8_192;
const BITBUCKET_MAX_SCOPE_HEADER_LENGTH = 4_096;

const ProviderStringSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(value => value.trim() === value);

const BitbucketWorkspacePayloadSchema = z.object({
  uuid: z.string(),
  slug: z.string(),
  name: ProviderStringSchema,
});

const BitbucketWorkspaceAccessPayloadSchema = z.object({
  workspace: z.object({
    uuid: z.string(),
    slug: z.string(),
  }),
});

const BitbucketWorkspaceDiscoveryPageSchema = z
  .object({
    pagelen: z.number().int().positive().max(BITBUCKET_WORKSPACE_DISCOVERY_PAGE_LENGTH),
    values: z
      .array(BitbucketWorkspaceAccessPayloadSchema)
      .max(BITBUCKET_WORKSPACE_DISCOVERY_PAGE_LENGTH),
    next: z.string().min(1).optional(),
  })
  .refine(page => page.values.length <= page.pagelen);

const BitbucketMembersPageSchema = z.object({
  pagelen: z.number().int().positive().max(1),
  values: z.array(z.unknown()).max(1),
});

const BitbucketRepositoryPayloadSchema = z.object({
  uuid: z.string(),
  name: ProviderStringSchema,
  slug: z.string(),
  full_name: z.string(),
  is_private: z.boolean(),
  workspace: z.object({
    uuid: z.string(),
    slug: z.string(),
  }),
  mainbranch: z.object({ name: ProviderStringSchema }).nullable().optional(),
});

const BitbucketRepositoryPageSchema = z
  .object({
    pagelen: z.number().int().positive().max(BITBUCKET_REPOSITORY_PAGE_LENGTH),
    values: z.array(BitbucketRepositoryPayloadSchema).max(BITBUCKET_REPOSITORY_PAGE_LENGTH),
    next: z.string().min(1).optional(),
  })
  .refine(page => page.values.length <= page.pagelen);

type BitbucketRepositoryPayload = z.infer<typeof BitbucketRepositoryPayloadSchema>;

export type BitbucketWorkspaceAccessTokenErrorCode =
  | 'invalid_token_format'
  | 'invalid_workspace_slug'
  | 'authentication_rejected'
  | 'permission_denied'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'request_failed'
  | 'request_timeout'
  | 'redirect_rejected'
  | 'response_too_large'
  | 'invalid_response'
  | 'invalid_pagination'
  | 'page_limit_exceeded'
  | 'item_limit_exceeded'
  | 'credential_type_missing'
  | 'credential_type_invalid'
  | 'scope_evidence_missing'
  | 'insufficient_scopes'
  | 'workspace_discovery_failed'
  | 'workspace_mismatch';

const ERROR_MESSAGES: Record<BitbucketWorkspaceAccessTokenErrorCode, string> = {
  invalid_token_format: 'The Bitbucket Workspace Access Token format is invalid',
  invalid_workspace_slug: 'The Bitbucket workspace slug is invalid',
  authentication_rejected: 'Bitbucket rejected the Workspace Access Token',
  permission_denied: 'The Bitbucket Workspace Access Token cannot access the requested workspace',
  rate_limited: 'Bitbucket temporarily rate limited credential validation',
  provider_unavailable: 'Bitbucket is temporarily unavailable',
  request_failed: 'Bitbucket credential validation failed',
  request_timeout: 'Bitbucket credential validation timed out',
  redirect_rejected: 'Bitbucket returned an unsafe redirect',
  response_too_large: 'Bitbucket returned an oversized response',
  invalid_response: 'Bitbucket returned an invalid response',
  invalid_pagination: 'Bitbucket returned unsafe repository pagination',
  page_limit_exceeded: 'Bitbucket repository pagination exceeded the page limit',
  item_limit_exceeded: 'Bitbucket repository pagination exceeded the repository limit',
  credential_type_missing: 'Bitbucket did not report the credential type',
  credential_type_invalid: 'The credential is not a Bitbucket Workspace Access Token',
  scope_evidence_missing: 'Bitbucket did not report credential scopes',
  insufficient_scopes: 'The Bitbucket Workspace Access Token is missing required permissions',
  workspace_discovery_failed:
    'Bitbucket did not report exactly one workspace for the Workspace Access Token',
  workspace_mismatch: 'The Bitbucket Workspace Access Token does not match the requested workspace',
};

function getBitbucketWorkspaceAccessTokenErrorMessage(
  code: BitbucketWorkspaceAccessTokenErrorCode,
  missingRequiredScopes: readonly BitbucketWorkspaceAccessTokenRequiredScope[]
): string {
  const message = ERROR_MESSAGES[code];
  if (code !== 'insufficient_scopes' || missingRequiredScopes.length === 0) return message;

  const missingPermissions = missingRequiredScopes
    .map(scope => BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_SCOPE_LABELS[scope])
    .join(', ');
  return `${message}: ${missingPermissions}`;
}

export class BitbucketWorkspaceAccessTokenError extends Error {
  readonly missingRequiredScopes: readonly BitbucketWorkspaceAccessTokenRequiredScope[];

  constructor(
    readonly code: BitbucketWorkspaceAccessTokenErrorCode,
    details: { missingRequiredScopes?: readonly BitbucketWorkspaceAccessTokenRequiredScope[] } = {}
  ) {
    const missingRequiredScopes = details.missingRequiredScopes ?? [];
    super(getBitbucketWorkspaceAccessTokenErrorMessage(code, missingRequiredScopes));
    this.name = 'BitbucketWorkspaceAccessTokenError';
    this.missingRequiredScopes = missingRequiredScopes;
  }
}

export type BitbucketWorkspaceAccessTokenRepository = {
  id: string;
  workspaceUuid: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch?: string;
};

export type BitbucketWorkspaceAccessTokenValidation = {
  workspace: {
    uuid: string;
    slug: string;
    displayName: string;
  };
  providerCredentialType: 'workspace_access_token';
  providerScopes: string[];
  repositories: BitbucketWorkspaceAccessTokenRepository[];
};

export type ValidateBitbucketWorkspaceAccessTokenInput = {
  accessToken: string;
  expectedWorkspaceUuid?: string;
  fetch?: typeof fetch;
};

function hasNonVisibleAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return true;
  }
  return false;
}

function isValidBitbucketSlug(value: string): boolean {
  return (
    value.length <= 255 && /^[a-z0-9][a-z0-9_.-]*$/.test(value) && value !== '.' && value !== '..'
  );
}

function normalizeBitbucketUuid(value: string): string | null {
  const unbraced = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  const normalized = unbraced.toLowerCase();
  return z.uuid().safeParse(normalized).success ? normalized : null;
}

function requireAccessTokenFormat(accessToken: string): void {
  if (
    !hasBitbucketAccessTokenFamilyPrefix(accessToken) ||
    accessToken.length > BITBUCKET_MAX_ACCESS_TOKEN_LENGTH ||
    hasNonVisibleAscii(accessToken)
  ) {
    throw new BitbucketWorkspaceAccessTokenError('invalid_token_format');
  }
}

function workspaceEndpoint(workspaceSlug: string): string {
  return `${BITBUCKET_API_ORIGIN}/2.0/workspaces/${encodeURIComponent(workspaceSlug)}`;
}

function workspaceDiscoveryEndpoint(): string {
  return `${BITBUCKET_API_ORIGIN}/2.0/user/workspaces?pagelen=${BITBUCKET_WORKSPACE_DISCOVERY_PAGE_LENGTH}`;
}

function membersEndpoint(workspaceSlug: string): string {
  return `${workspaceEndpoint(workspaceSlug)}/members?pagelen=1`;
}

function repositoriesEndpoint(workspaceSlug: string): string {
  return `${BITBUCKET_API_ORIGIN}/2.0/repositories/${encodeURIComponent(workspaceSlug)}?pagelen=${BITBUCKET_REPOSITORY_PAGE_LENGTH}`;
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError'
  );
}

function mapResponseStatus(status: number): never {
  if (status === 401) throw new BitbucketWorkspaceAccessTokenError('authentication_rejected');
  if (status === 403) throw new BitbucketWorkspaceAccessTokenError('permission_denied');
  if (status === 429) throw new BitbucketWorkspaceAccessTokenError('rate_limited');
  if (status >= 500) throw new BitbucketWorkspaceAccessTokenError('provider_unavailable');
  throw new BitbucketWorkspaceAccessTokenError('request_failed');
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !response.body) {
    throw new BitbucketWorkspaceAccessTokenError('invalid_response');
  }

  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    if (!/^[0-9]+$/.test(contentLength)) {
      throw new BitbucketWorkspaceAccessTokenError('invalid_response');
    }
    if (Number(contentLength) > BITBUCKET_MAX_RESPONSE_BYTES) {
      throw new BitbucketWorkspaceAccessTokenError('response_too_large');
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const chunkValue: unknown = chunk.value;
      if (!(chunkValue instanceof Uint8Array)) {
        throw new BitbucketWorkspaceAccessTokenError('invalid_response');
      }
      totalBytes += chunkValue.byteLength;
      if (totalBytes > BITBUCKET_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read remains failed if cancellation also fails.
        }
        throw new BitbucketWorkspaceAccessTokenError('response_too_large');
      }
      chunks.push(chunkValue);
    }
  } catch (error) {
    if (error instanceof BitbucketWorkspaceAccessTokenError) throw error;
    if (isTimeoutError(error) || (signal.aborted && isTimeoutError(signal.reason))) {
      throw new BitbucketWorkspaceAccessTokenError('request_timeout');
    }
    throw new BitbucketWorkspaceAccessTokenError('invalid_response');
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new BitbucketWorkspaceAccessTokenError('invalid_response');
  }
}

async function fetchBitbucketJson(
  endpoint: string,
  accessToken: string,
  fetchImplementation: typeof fetch
): Promise<{ payload: unknown; headers: Headers }> {
  const signal = AbortSignal.timeout(BITBUCKET_PROVIDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
  } catch (error) {
    if (isTimeoutError(error) || (signal.aborted && isTimeoutError(signal.reason))) {
      throw new BitbucketWorkspaceAccessTokenError('request_timeout');
    }
    throw new BitbucketWorkspaceAccessTokenError('request_failed');
  }

  if (
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    (response.url !== '' && response.url !== endpoint)
  ) {
    throw new BitbucketWorkspaceAccessTokenError('redirect_rejected');
  }
  if (response.status !== 200) mapResponseStatus(response.status);

  return {
    payload: await readBoundedJson(response, signal),
    headers: response.headers,
  };
}

function readCredentialEvidence(headers: Headers): {
  providerCredentialType: 'workspace_access_token';
  providerScopes: string[];
} {
  const credentialType = headers.get('X-Credential-Type');
  if (!credentialType) {
    throw new BitbucketWorkspaceAccessTokenError('credential_type_missing');
  }
  if (credentialType !== BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE) {
    throw new BitbucketWorkspaceAccessTokenError('credential_type_invalid');
  }

  const providerScopes = readProviderScopes(headers);
  if (providerScopes.length === 0) {
    throw new BitbucketWorkspaceAccessTokenError('scope_evidence_missing');
  }

  return {
    providerCredentialType: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
    providerScopes,
  };
}

function readProviderScopes(headers: Headers): string[] {
  const scopeHeader = headers.get('X-OAuth-Scopes');
  if (!scopeHeader) return [];
  if (scopeHeader.length > BITBUCKET_MAX_SCOPE_HEADER_LENGTH) {
    throw new BitbucketWorkspaceAccessTokenError('scope_evidence_missing');
  }
  return normalizeBitbucketWorkspaceAccessTokenScopes(scopeHeader);
}

function requireProviderScopes(providerScopes: readonly string[]): void {
  const missingRequiredScopes = getMissingBitbucketWorkspaceAccessTokenScopes(providerScopes);
  if (missingRequiredScopes.length > 0) {
    throw new BitbucketWorkspaceAccessTokenError('insufficient_scopes', {
      missingRequiredScopes,
    });
  }
}

function normalizeDiscoveredWorkspace(payload: { uuid: string; slug: string }): {
  uuid: string;
  slug: string;
} {
  const uuid = normalizeBitbucketUuid(payload.uuid);
  if (!uuid || !isValidBitbucketSlug(payload.slug)) {
    throw new BitbucketWorkspaceAccessTokenError('workspace_discovery_failed');
  }
  return { uuid, slug: payload.slug };
}

async function discoverWorkspace(input: { accessToken: string; fetch: typeof fetch }): Promise<{
  workspace: { uuid: string; slug: string };
  evidence: {
    providerCredentialType: 'workspace_access_token';
    providerScopes: string[];
  };
}> {
  const discoveryResult = await fetchBitbucketJson(
    workspaceDiscoveryEndpoint(),
    input.accessToken,
    input.fetch
  );
  const evidence = readCredentialEvidence(discoveryResult.headers);
  const page = BitbucketWorkspaceDiscoveryPageSchema.safeParse(discoveryResult.payload);
  if (!page.success || page.data.values.length !== 1 || page.data.next) {
    throw new BitbucketWorkspaceAccessTokenError('workspace_discovery_failed');
  }

  return {
    workspace: normalizeDiscoveredWorkspace(page.data.values[0].workspace),
    evidence,
  };
}

function normalizeRepository(
  repository: BitbucketRepositoryPayload,
  workspace: { uuid: string; slug: string }
): BitbucketWorkspaceAccessTokenRepository {
  const id = normalizeBitbucketUuid(repository.uuid);
  const repositoryWorkspaceUuid = normalizeBitbucketUuid(repository.workspace.uuid);
  if (
    !id ||
    repositoryWorkspaceUuid !== workspace.uuid ||
    repository.workspace.slug !== workspace.slug ||
    !isValidBitbucketSlug(repository.slug) ||
    repository.full_name !== `${workspace.slug}/${repository.slug}`
  ) {
    throw new BitbucketWorkspaceAccessTokenError('invalid_response');
  }

  return {
    id,
    workspaceUuid: workspace.uuid,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.is_private,
    ...(repository.mainbranch ? { defaultBranch: repository.mainbranch.name } : {}),
  };
}

function validateRepositoryNextLink(value: string, workspaceSlug: string): string {
  if (!isValidBitbucketRepositoryPaginationUrl(value, workspaceSlug)) {
    throw new BitbucketWorkspaceAccessTokenError('invalid_pagination');
  }
  return value;
}

async function listWorkspaceRepositories(input: {
  workspace: { uuid: string; slug: string };
  accessToken: string;
  fetch: typeof fetch;
  recordProviderScopes?: (headers: Headers) => void;
}): Promise<BitbucketWorkspaceAccessTokenRepository[]> {
  const repositories: BitbucketWorkspaceAccessTokenRepository[] = [];
  const repositoryIds = new Set<string>();
  const repositoryFullNames = new Set<string>();
  const visitedEndpoints = new Set<string>();
  let endpoint: string | undefined = repositoriesEndpoint(input.workspace.slug);

  for (let pageNumber = 0; endpoint; pageNumber += 1) {
    if (pageNumber >= BITBUCKET_MAX_REPOSITORY_PAGES) {
      throw new BitbucketWorkspaceAccessTokenError('page_limit_exceeded');
    }
    if (visitedEndpoints.has(endpoint)) {
      throw new BitbucketWorkspaceAccessTokenError('invalid_pagination');
    }
    visitedEndpoints.add(endpoint);

    const { payload, headers } = await fetchBitbucketJson(endpoint, input.accessToken, input.fetch);
    input.recordProviderScopes?.(headers);
    const page = BitbucketRepositoryPageSchema.safeParse(payload);
    if (!page.success) throw new BitbucketWorkspaceAccessTokenError('invalid_response');

    for (const repositoryPayload of page.data.values) {
      const repository = normalizeRepository(repositoryPayload, input.workspace);
      if (repositoryIds.has(repository.id) || repositoryFullNames.has(repository.fullName)) {
        throw new BitbucketWorkspaceAccessTokenError('invalid_response');
      }
      repositoryIds.add(repository.id);
      repositoryFullNames.add(repository.fullName);
      repositories.push(repository);
      if (repositories.length > BITBUCKET_MAX_REPOSITORY_ITEMS) {
        throw new BitbucketWorkspaceAccessTokenError('item_limit_exceeded');
      }
    }

    if (!page.data.next) return repositories;
    if (repositories.length >= BITBUCKET_MAX_REPOSITORY_ITEMS) {
      throw new BitbucketWorkspaceAccessTokenError('item_limit_exceeded');
    }
    endpoint = validateRepositoryNextLink(page.data.next, input.workspace.slug);
  }

  return repositories;
}

export async function validateBitbucketWorkspaceAccessToken(
  input: ValidateBitbucketWorkspaceAccessTokenInput
): Promise<BitbucketWorkspaceAccessTokenValidation> {
  requireAccessTokenFormat(input.accessToken);
  const expectedWorkspaceUuid = input.expectedWorkspaceUuid
    ? normalizeBitbucketUuid(input.expectedWorkspaceUuid)
    : undefined;
  if (input.expectedWorkspaceUuid && !expectedWorkspaceUuid) {
    throw new BitbucketWorkspaceAccessTokenError('workspace_mismatch');
  }
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const discovered = await discoverWorkspace({
    accessToken: input.accessToken,
    fetch: fetchImplementation,
  });
  const observedProviderScopes = new Set(discovered.evidence.providerScopes);
  const recordProviderScopes = (headers: Headers) => {
    for (const scope of readProviderScopes(headers)) {
      observedProviderScopes.add(scope);
    }
  };
  if (expectedWorkspaceUuid && discovered.workspace.uuid !== expectedWorkspaceUuid) {
    throw new BitbucketWorkspaceAccessTokenError('workspace_mismatch');
  }

  const workspaceResult = await fetchBitbucketJson(
    workspaceEndpoint(discovered.workspace.slug),
    input.accessToken,
    fetchImplementation
  );
  recordProviderScopes(workspaceResult.headers);
  const workspacePayload = BitbucketWorkspacePayloadSchema.safeParse(workspaceResult.payload);
  if (!workspacePayload.success) {
    throw new BitbucketWorkspaceAccessTokenError('invalid_response');
  }

  const workspaceUuid = normalizeBitbucketUuid(workspacePayload.data.uuid);
  if (
    !workspaceUuid ||
    workspaceUuid !== discovered.workspace.uuid ||
    workspacePayload.data.slug !== discovered.workspace.slug ||
    !isValidBitbucketSlug(workspacePayload.data.slug) ||
    (expectedWorkspaceUuid && workspaceUuid !== expectedWorkspaceUuid)
  ) {
    throw new BitbucketWorkspaceAccessTokenError('workspace_mismatch');
  }
  const workspace = {
    uuid: workspaceUuid,
    slug: workspacePayload.data.slug,
    displayName: workspacePayload.data.name,
  };

  const membersResult = await fetchBitbucketJson(
    membersEndpoint(workspace.slug),
    input.accessToken,
    fetchImplementation
  );
  recordProviderScopes(membersResult.headers);
  if (!BitbucketMembersPageSchema.safeParse(membersResult.payload).success) {
    throw new BitbucketWorkspaceAccessTokenError('invalid_response');
  }

  const repositories = await listWorkspaceRepositories({
    workspace,
    accessToken: input.accessToken,
    fetch: fetchImplementation,
    recordProviderScopes,
  });
  const providerScopes = normalizeBitbucketWorkspaceAccessTokenScopes(
    [...observedProviderScopes].join(' ')
  );
  requireProviderScopes(providerScopes);

  return {
    workspace,
    providerCredentialType: discovered.evidence.providerCredentialType,
    providerScopes,
    repositories,
  };
}
