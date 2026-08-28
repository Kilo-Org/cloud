import 'server-only';

import { Gitlab } from '@gitbeaker/rest';
import {
  createRequesterFn,
  type FormattedResponse,
  type ResponseBodyTypes,
} from '@gitbeaker/requester-utils';
import { REVIEW_WRITE_REQUEST_MAX_BYTES } from '@kilocode/app-shared/provider-review';
import { z } from 'zod';
import {
  fetchGitLabCredential,
  type GitLabCredentialActor,
  type GitLabCredentialSelector,
} from './credential-broker-client';
import { buildGitLabUrl, normalizeGitLabInstanceUrl } from './instance-url';
import {
  assertGitLabRequestBodySize,
  assertGitLabTransportUrl,
  fetchGitLab,
  GITLAB_REQUEST_TIMEOUT_MS,
  GitLabTransportError,
  MAX_GITLAB_RESPONSE_BYTES,
} from './safe-transport';

type GitLabSdk = InstanceType<typeof Gitlab<false>>;
// Only these SDK operations belong to discovery and interactive review. No credential fields escape.
export type GitLabInteractiveOperations = {
  Users: Pick<GitLabSdk['Users'], 'showCurrentUser'>;
  Metadata: Pick<GitLabSdk['Metadata'], 'show'>;
  Projects: Pick<GitLabSdk['Projects'], 'all' | 'show'>;
  Branches: Pick<GitLabSdk['Branches'], 'all' | 'show' | 'remove'>;
  MergeRequests: Pick<
    GitLabSdk['MergeRequests'],
    | 'all'
    | 'show'
    | 'allDiffs'
    | 'allDiffVersions'
    | 'showDiffVersion'
    | 'allCommits'
    | 'allPipelines'
    | 'showReviewers'
    | 'merge'
    | 'rebase'
    | 'cancelOnPipelineSuccess'
  >;
  MergeRequestApprovals: Pick<
    GitLabSdk['MergeRequestApprovals'],
    'showConfiguration' | 'showApprovalState' | 'approve' | 'unapprove'
  >;
  MergeRequestDiscussions: Pick<
    GitLabSdk['MergeRequestDiscussions'],
    'all' | 'show' | 'create' | 'addNote' | 'editNote' | 'resolve'
  >;
  MergeRequestNotes: Pick<GitLabSdk['MergeRequestNotes'], 'all' | 'show' | 'create' | 'edit'>;
  MergeRequestDraftNotes: Pick<
    GitLabSdk['MergeRequestDraftNotes'],
    'all' | 'show' | 'create' | 'edit' | 'publish' | 'publishBulk' | 'remove'
  >;
  MergeRequestAwardEmojis: Pick<GitLabSdk['MergeRequestAwardEmojis'], 'all' | 'award' | 'remove'>;
  MergeRequestNoteAwardEmojis: Pick<
    GitLabSdk['MergeRequestNoteAwardEmojis'],
    'all' | 'award' | 'remove'
  >;
  RepositoryFiles: Pick<GitLabSdk['RepositoryFiles'], 'show' | 'showRaw'>;
  Pipelines: Pick<GitLabSdk['Pipelines'], 'show'>;
  Jobs: Pick<GitLabSdk['Jobs'], 'all'>;
  Commits: Pick<GitLabSdk['Commits'], 'show' | 'allStatuses'>;
};

export type GitLabInteractiveScope = { kind: 'discovery' } | { kind: 'project'; projectId: string };
export type GitLabInteractiveResponse<T> =
  | { status: 200 | 201 | 202; data: T; headers: Record<string, string> }
  | { status: 204; data: null; headers: Record<string, string> };

type ErrorCode =
  | 'invalid_request'
  | 'not_connected'
  | 'reconnect_required'
  | 'temporarily_unavailable'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'provider_error'
  | 'invalid_response'
  | 'pagination_limit'
  | GitLabTransportError['code'];

export class GitLabInteractiveError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status?: number
  ) {
    super(
      `GitLab interactive request failed: ${code}${status === undefined ? '' : ` (${status})`}`
    );
    this.name = 'GitLabInteractiveError';
  }
}

function redactError(error: unknown): GitLabInteractiveError {
  if (error instanceof GitLabInteractiveError) return error;
  if (error instanceof GitLabTransportError) return new GitLabInteractiveError(error.code);
  // Never retain SDK causes, provider text, request/response objects, or token-bearing headers.
  return new GitLabInteractiveError('temporarily_unavailable');
}

const RequestOptionsSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  prefixUrl: z.string(),
  searchParams: z.string().optional(),
  body: z.union([z.string(), z.instanceof(FormData)]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  asStream: z.boolean().optional(),
  signal: z.instanceof(AbortSignal).optional(),
});
const JsonResponseSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);
const MAX_PAGES = 100;

function pageScope(url: URL): string {
  const query = new URLSearchParams(url.search);
  for (const key of ['page', 'id_after', 'id_before', 'cursor']) query.delete(key);
  if (!query.has('per_page')) query.set('per_page', '20');
  query.sort();
  return query.toString();
}

function validatePage(url: URL): void {
  const perPage = Number(url.searchParams.get('per_page') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  ) {
    throw new GitLabInteractiveError('invalid_request');
  }
}

function responseHeaders(
  response: Response,
  url: URL,
  instanceUrl: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    'content-type',
    'link',
    'x-page',
    'x-next-page',
    'x-prev-page',
    'x-per-page',
    'x-total',
    'x-total-pages',
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  // Gitbeaker follows a link's query but discards its host/path. Validate both before SDK pagination.
  for (const match of (headers.link ?? '').matchAll(/<([^>]+)>/g)) {
    const next = new URL(match[1], url);
    assertGitLabTransportUrl(next, instanceUrl);
    validatePage(next);
    if (next.pathname !== url.pathname || pageScope(next) !== pageScope(url)) {
      throw new GitLabInteractiveError('unsafe_url');
    }
  }
  const location = response.headers.get('location');
  if (location) {
    const task = new URL(location, url);
    assertGitLabTransportUrl(task, instanceUrl);
    // A task can add a suffix, but cannot switch the operation's resource.
    if (task.pathname !== url.pathname && !task.pathname.startsWith(`${url.pathname}/`)) {
      throw new GitLabInteractiveError('unsafe_url');
    }
    headers.location = task.toString();
  }
  return headers;
}

// The caller resolves the owner/integration and project before constructing this server-only client.
// The broker retains refresh/invalidation ownership; no credential cache or mutation retry lives here.
export function createGitLabInteractiveClient(input: {
  actor: GitLabCredentialActor;
  selector: GitLabCredentialSelector;
  instanceUrl: string;
  scope: GitLabInteractiveScope;
}) {
  let instanceUrl: string;
  try {
    instanceUrl = normalizeGitLabInstanceUrl(input.instanceUrl);
  } catch {
    throw new GitLabInteractiveError('unsafe_url');
  }
  if (
    input.scope.kind === 'project' &&
    (!input.scope.projectId ||
      input.scope.projectId
        .split('/')
        .some(segment => !segment || segment === '.' || segment === '..'))
  ) {
    throw new GitLabInteractiveError('invalid_request');
  }
  const apiRoot = buildGitLabUrl(instanceUrl, '/api/v4/');
  const projectId = input.scope.kind === 'project' ? input.scope.projectId : null;
  const projectPath =
    projectId === null
      ? null
      : new URL(buildGitLabUrl(instanceUrl, `/api/v4/projects/${encodeURIComponent(projectId)}`))
          .pathname;
  const graphqlUrl = buildGitLabUrl(instanceUrl, '/api/graphql');

  async function run<T>(
    operation: (
      sdk: GitLabSdk,
      requestChanges: (mergeRequestIid: number) => Promise<ResponseBodyTypes>
    ) => Promise<T>
  ): Promise<GitLabInteractiveResponse<T>> {
    let authorizedGraphqlBody: string | undefined;
    let count = 0;
    let responseBytes = 0;
    const seen = new Set<string>();
    let last: Pick<FormattedResponse, 'status' | 'headers'> | undefined;

    async function dispatch(
      endpoint: string,
      rawOptions?: Record<string, unknown>
    ): Promise<FormattedResponse> {
      const parsed = RequestOptionsSchema.safeParse(rawOptions);
      if (!parsed.success) throw new GitLabInteractiveError('invalid_request');
      const options = parsed.data;
      // Some SDK resources use a prefix such as api/v4/projects without a trailing slash.
      const prefix = options.prefixUrl.endsWith('/') ? options.prefixUrl : `${options.prefixUrl}/`;
      const url = new URL(endpoint, prefix);
      url.search = options.searchParams ?? '';
      assertGitLabTransportUrl(url, instanceUrl);
      // Native serialization retains the SDK's multipart positions and UTF-8 text without a custom encoder.
      const multipart =
        options.body instanceof FormData
          ? new Request(url, { method: options.method, body: options.body })
          : undefined;
      const requestBody = multipart ? await multipart.arrayBuffer() : options.body;
      const requestContentType = multipart?.headers.get('content-type') ?? 'application/json';
      assertGitLabRequestBodySize(requestBody, REVIEW_WRITE_REQUEST_MAX_BYTES);
      validatePage(url);
      if (new Headers(options.headers).has('sudo')) throw new GitLabInteractiveError('forbidden');
      const isProject =
        projectPath !== null &&
        (url.pathname === projectPath || url.pathname.startsWith(`${projectPath}/`));
      const isMetadata =
        options.method === 'GET' &&
        ['user', 'metadata'].some(path => url.toString() === `${apiRoot}${path}`);
      const isDiscovery =
        input.scope.kind === 'discovery' &&
        options.method === 'GET' &&
        ['projects', 'merge_requests'].some(
          path => url.pathname === new URL(`${apiRoot}${path}`).pathname
        );
      // Only requestChanges can supply this server-built document and its bound variables.
      const isGraphql =
        projectPath !== null &&
        url.toString() === graphqlUrl &&
        options.method === 'POST' &&
        authorizedGraphqlBody !== undefined &&
        requestBody === authorizedGraphqlBody;
      if (!isProject && !isMetadata && !isDiscovery && !isGraphql)
        throw new GitLabInteractiveError('unsafe_url');
      if (
        input.selector.credential === 'project-exact' &&
        (input.scope.kind !== 'project' || input.scope.projectId !== input.selector.projectId)
      ) {
        throw new GitLabInteractiveError('forbidden');
      }
      if (++count > MAX_PAGES || (options.method === 'GET' && seen.has(url.toString()))) {
        throw new GitLabInteractiveError('pagination_limit');
      }
      seen.add(url.toString());
      const credential = await fetchGitLabCredential(input.actor, input.selector);
      if (credential.status !== 'available') throw new GitLabInteractiveError(credential.status);
      if (normalizeGitLabInstanceUrl(credential.instanceUrl) !== instanceUrl)
        throw new GitLabInteractiveError('unsafe_url');
      const resourcePath = projectPath === null ? '' : url.pathname.slice(projectPath.length);
      const rawDiff =
        options.method === 'GET' && /^\/merge_requests\/[1-9]\d*\/raw_diffs$/.test(resourcePath);
      const rawFile =
        options.method === 'GET' && /^\/repository\/files\/[^/]+\/raw$/.test(resourcePath);
      const raw = rawDiff || rawFile;
      const response = await fetchGitLab(
        url.toString(),
        {
          method: options.method,
          body: requestBody,
          signal: options.signal,
          headers: {
            Accept: raw ? 'text/plain, application/octet-stream' : 'application/json',
            Authorization: `Bearer ${credential.token}`,
            ...(requestBody === undefined ? {} : { 'Content-Type': requestContentType }),
          },
        },
        {
          instanceUrl,
          maxRequestBytes: REVIEW_WRITE_REQUEST_MAX_BYTES,
          rejectRedirects: options.method !== 'GET',
          resourceUrl: url.toString(),
        }
      );
      if (![200, 201, 202, 204].includes(response.status)) {
        const code =
          response.status === 401
            ? 'reconnect_required'
            : response.status === 403
              ? 'forbidden'
              : response.status === 404
                ? 'not_found'
                : response.status === 409
                  ? 'conflict'
                  : response.status === 429 || response.status >= 500
                    ? 'temporarily_unavailable'
                    : 'provider_error';
        throw new GitLabInteractiveError(code, response.status);
      }
      const headers = responseHeaders(response, url, instanceUrl);
      last = { status: response.status, headers };
      let body: ResponseBodyTypes = null;
      if (response.status !== 204) {
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase();
        if (
          raw
            ? !['text/plain', 'text/x-diff', 'text/x-patch', 'application/octet-stream'].includes(
                contentType ?? ''
              )
            : contentType !== 'application/json'
        ) {
          throw new GitLabInteractiveError('invalid_response');
        }
        const bytes = await response.arrayBuffer();
        responseBytes += bytes.byteLength;
        if (responseBytes > MAX_GITLAB_RESPONSE_BYTES)
          throw new GitLabInteractiveError('response_too_large');
        const blob = new Blob([bytes], { type: contentType });
        if (options.asStream) body = blob.stream();
        else if (raw)
          body = contentType === 'application/octet-stream' && !rawDiff ? blob : await blob.text();
        else {
          try {
            body = JsonResponseSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
            );
          } catch {
            throw new GitLabInteractiveError('invalid_response');
          }
        }
      }
      return { body, ...last };
    }

    try {
      const sdk = new Gitlab({
        host: instanceUrl,
        queryTimeout: GITLAB_REQUEST_TIMEOUT_MS,
        requesterFn: createRequesterFn((_resource, options) => Promise.resolve(options), dispatch),
      });
      async function requestChanges(mergeRequestIid: number): Promise<ResponseBodyTypes> {
        if (projectId === null || !Number.isSafeInteger(mergeRequestIid) || mergeRequestIid < 1)
          throw new GitLabInteractiveError('invalid_request');
        let fullPath = projectId;
        if (/^\d+$/.test(projectId)) {
          // GraphQL requires a full path. Resolve numeric IDs only through the authorized REST resource.
          const project = await sdk.Projects.show(projectId);
          const identity = z
            .object({ id: z.number().int().positive(), path_with_namespace: z.string().min(1) })
            .safeParse(project);
          if (!identity.success || String(identity.data.id) !== projectId)
            throw new GitLabInteractiveError('invalid_response');
          fullPath = identity.data.path_with_namespace;
        }
        // https://docs.gitlab.com/api/graphql/reference/#mutationmergerequestrequestchanges
        authorizedGraphqlBody = JSON.stringify({
          query: `mutation RequestChanges($projectPath: ID!, $iid: String!) {
            mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) {
              mergeRequest { id iid }
              errors
            }
          }`,
          variables: { projectPath: fullPath, iid: String(mergeRequestIid) },
        });
        const response = await dispatch(graphqlUrl, {
          prefixUrl: apiRoot,
          method: 'POST',
          body: authorizedGraphqlBody,
        });
        return response.body;
      }
      const data = await operation(sdk, requestChanges);
      if (!last || ![200, 201, 202, 204].includes(last.status))
        throw new GitLabInteractiveError('invalid_response');
      if (last.status === 204) return { ...last, status: 204, data: null };
      if (last.status === 200 || last.status === 201 || last.status === 202)
        return { ...last, status: last.status, data };
      throw new GitLabInteractiveError('invalid_response');
    } catch (error) {
      throw redactError(error);
    }
  }

  return {
    // Execute one SDK operation per call; the ledger records each batch effect separately.
    execute: <T>(operation: (sdk: GitLabInteractiveOperations) => Promise<T>) =>
      run(sdk => operation(sdk)),
    rawDiff: (mergeRequestIid: number, asStream = false) =>
      run(async sdk => {
        if (
          input.scope.kind !== 'project' ||
          !Number.isSafeInteger(mergeRequestIid) ||
          mergeRequestIid < 1
        )
          throw new GitLabInteractiveError('invalid_request');
        const response = await sdk.requester.get<string | ReadableStream>(
          `projects/${encodeURIComponent(input.scope.projectId)}/merge_requests/${mergeRequestIid}/raw_diffs`,
          { asStream }
        );
        return response.body;
      }),
    requestChanges: (mergeRequestIid: number) =>
      run((_sdk, requestChanges) => requestChanges(mergeRequestIid)),
  };
}
