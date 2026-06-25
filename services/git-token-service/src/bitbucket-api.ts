import { isValidBitbucketRepositoryPaginationUrl } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { z } from 'zod';
import { normalizeBitbucketUuid } from './bitbucket-url.js';

const BITBUCKET_REPOSITORY_PAGE_LENGTH = 50;
const BITBUCKET_MAX_REPOSITORY_PAGES = 20;
const BITBUCKET_MAX_REPOSITORY_ITEMS = 500;
const BITBUCKET_MAX_RESPONSE_BYTES = 1_000_000;
const BITBUCKET_REQUEST_TIMEOUT_MS = 10_000;
const BITBUCKET_MAX_REQUEST_TIMEOUT_MS = 30_000;

const BitbucketRepositoryPayloadSchema = z.object({
  uuid: z.string(),
  name: z.string().min(1),
  slug: z.string().min(1),
  full_name: z.string().min(3),
  is_private: z.boolean(),
  workspace: z.object({
    uuid: z.string(),
    slug: z.string().min(1),
  }),
  mainbranch: z
    .object({ name: z.string().min(1) })
    .nullable()
    .optional(),
});

const BitbucketRepositoryPageSchema = z
  .object({
    pagelen: z.number().int().positive().max(BITBUCKET_REPOSITORY_PAGE_LENGTH),
    values: z.array(BitbucketRepositoryPayloadSchema).max(BITBUCKET_REPOSITORY_PAGE_LENGTH),
    next: z.string().min(1).optional(),
  })
  .refine(page => page.values.length <= page.pagelen);

type BitbucketRepositoryPayload = z.infer<typeof BitbucketRepositoryPayloadSchema>;

export type BitbucketRepository = {
  id: string;
  workspaceUuid: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch?: string;
};

export type BitbucketRepositoryApiOptions = {
  accessToken: string;
  workspace: {
    slug: string;
    uuid: string;
  };
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
};

export type BitbucketApiErrorCode =
  | 'invalid_request'
  | 'request_failed'
  | 'request_timed_out'
  | 'transport_failed'
  | 'authentication_rejected'
  | 'insufficient_permissions'
  | 'not_found'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'redirect_rejected'
  | 'invalid_response'
  | 'workspace_mismatch'
  | 'invalid_pagination'
  | 'page_limit_exceeded'
  | 'item_limit_exceeded'
  | 'response_too_large';

export class BitbucketApiError extends Error {
  constructor(readonly code: BitbucketApiErrorCode) {
    super(code);
    this.name = 'BitbucketApiError';
  }
}

function isValidBitbucketPathSegment(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
}

function repositoryEndpoint(workspaceSlug: string): string {
  return `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspaceSlug)}?pagelen=${BITBUCKET_REPOSITORY_PAGE_LENGTH}`;
}

function hasNonVisibleAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return true;
  }
  return false;
}

function validateNextLink(value: string, workspaceSlug: string): string {
  if (!isValidBitbucketRepositoryPaginationUrl(value, workspaceSlug)) {
    throw new BitbucketApiError('invalid_pagination');
  }
  return value;
}

function normalizeRepository(
  repository: BitbucketRepositoryPayload,
  workspace: { slug: string; uuid: string }
): BitbucketRepository {
  const id = normalizeBitbucketUuid(repository.uuid);
  const repositoryWorkspaceUuid = normalizeBitbucketUuid(repository.workspace.uuid);
  if (!id || !repositoryWorkspaceUuid || !isValidBitbucketPathSegment(repository.slug)) {
    throw new BitbucketApiError('invalid_response');
  }
  if (
    repositoryWorkspaceUuid !== workspace.uuid ||
    repository.workspace.slug !== workspace.slug ||
    repository.full_name !== `${workspace.slug}/${repository.slug}`
  ) {
    throw new BitbucketApiError('workspace_mismatch');
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

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new BitbucketApiError('invalid_response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const chunkValue: unknown = chunk.value;
      if (!(chunkValue instanceof Uint8Array)) {
        throw new BitbucketApiError('invalid_response');
      }
      totalBytes += chunkValue.byteLength;
      if (totalBytes > BITBUCKET_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read still fails closed if cancellation itself fails.
        }
        throw new BitbucketApiError('response_too_large');
      }
      chunks.push(chunkValue);
    }
  } catch (error) {
    if (error instanceof BitbucketApiError) throw error;
    throw new BitbucketApiError(signal.aborted ? 'request_timed_out' : 'invalid_response');
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new BitbucketApiError('invalid_response');
  }
}

async function fetchRepositoryPage(
  endpoint: string,
  accessToken: string,
  fetchImplementation: typeof fetch,
  requestTimeoutMs: number
): Promise<z.infer<typeof BitbucketRepositoryPageSchema>> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      redirect: 'manual',
      signal,
    });
  } catch {
    throw new BitbucketApiError(signal.aborted ? 'request_timed_out' : 'transport_failed');
  }

  if (
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    (response.url !== '' && response.url !== endpoint)
  ) {
    throw new BitbucketApiError('redirect_rejected');
  }
  if (response.status === 401) throw new BitbucketApiError('authentication_rejected');
  if (response.status === 403) throw new BitbucketApiError('insufficient_permissions');
  if (response.status === 404) throw new BitbucketApiError('not_found');
  if (response.status === 429) throw new BitbucketApiError('rate_limited');
  if (response.status >= 500 && response.status <= 599) {
    throw new BitbucketApiError('provider_unavailable');
  }
  if (response.status !== 200) throw new BitbucketApiError('request_failed');

  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new BitbucketApiError('invalid_response');

  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    if (!/^[0-9]+$/.test(contentLength)) throw new BitbucketApiError('invalid_response');
    if (Number(contentLength) > BITBUCKET_MAX_RESPONSE_BYTES) {
      throw new BitbucketApiError('response_too_large');
    }
  }

  const payload = await readBoundedJson(response, signal);
  const page = BitbucketRepositoryPageSchema.safeParse(payload);
  if (!page.success) throw new BitbucketApiError('invalid_response');
  return page.data;
}

export async function listBitbucketWorkspaceRepositories(
  options: BitbucketRepositoryApiOptions
): Promise<BitbucketRepository[]> {
  const workspaceUuid = normalizeBitbucketUuid(options.workspace.uuid);
  const requestTimeoutMs = options.requestTimeoutMs ?? BITBUCKET_REQUEST_TIMEOUT_MS;
  if (
    !workspaceUuid ||
    !isValidBitbucketPathSegment(options.workspace.slug) ||
    options.accessToken === '' ||
    hasNonVisibleAscii(options.accessToken) ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    requestTimeoutMs > BITBUCKET_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new BitbucketApiError('invalid_request');
  }

  const workspace = { slug: options.workspace.slug, uuid: workspaceUuid };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const repositories: BitbucketRepository[] = [];
  const repositoryIds = new Set<string>();
  const repositoryFullNames = new Set<string>();
  const visited = new Set<string>();
  let endpoint: string | undefined = repositoryEndpoint(workspace.slug);

  for (let pageNumber = 0; endpoint; pageNumber += 1) {
    if (pageNumber >= BITBUCKET_MAX_REPOSITORY_PAGES) {
      throw new BitbucketApiError('page_limit_exceeded');
    }
    if (visited.has(endpoint)) throw new BitbucketApiError('invalid_pagination');
    visited.add(endpoint);

    const page = await fetchRepositoryPage(
      endpoint,
      options.accessToken,
      fetchImplementation,
      requestTimeoutMs
    );
    for (const payload of page.values) {
      const repository = normalizeRepository(payload, workspace);
      if (repositoryIds.has(repository.id) || repositoryFullNames.has(repository.fullName)) {
        throw new BitbucketApiError('invalid_response');
      }
      repositoryIds.add(repository.id);
      repositoryFullNames.add(repository.fullName);
      repositories.push(repository);
      if (repositories.length > BITBUCKET_MAX_REPOSITORY_ITEMS) {
        throw new BitbucketApiError('item_limit_exceeded');
      }
    }

    if (!page.next) return repositories;
    if (repositories.length >= BITBUCKET_MAX_REPOSITORY_ITEMS) {
      throw new BitbucketApiError('item_limit_exceeded');
    }
    endpoint = validateNextLink(page.next, workspace.slug);
  }

  return repositories;
}
