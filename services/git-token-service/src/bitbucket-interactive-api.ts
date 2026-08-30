import createClient, {
  type FetchOptions,
  type FetchResponse,
  type RequestBodyOption,
} from 'openapi-fetch';
import { z } from 'zod';
import { ReviewActorSchema } from '../../../packages/app-shared/src/provider-review/contracts.js';
import type { components, paths } from './bitbucket-openapi.js';
import { normalizeBitbucketUuid } from './bitbucket-url.js';
import {
  BITBUCKET_API_ROOT,
  BITBUCKET_INTERACTIVE_REQUEST_MAX_BYTES,
  BITBUCKET_MAX_RESPONSE_BYTES,
  BitbucketInteractiveError,
  BitbucketApiError,
  assertBitbucketRequestSize,
  assertBitbucketUrl,
  fetchBitbucket,
  readBoundedBitbucketBody,
} from './bitbucket-safe-transport.js';

const repository = '/repositories/{workspace}/{repo_slug}' as const;
const review = `${repository}/pullrequests/{pull_request_id}` as const;
const comments = `${review}/comments` as const;
const comment = `${comments}/{comment_id}` as const;
// This closed list selects SDK operations, not a general provider or arbitrary-URL client.
const operations = {
  repositories: ['get', '/repositories/{workspace}', [200], 'page'],
  repository: ['get', repository, [200], 'json'],
  branches: ['get', `${repository}/refs/branches`, [200], 'page'],
  branch: ['get', `${repository}/refs/branches/{name}`, [200], 'json'],
  deleteBranch: ['delete', `${repository}/refs/branches/{name}`, [204], 'json'],
  restrictions: ['get', `${repository}/branch-restrictions`, [200], 'page'],
  pullRequests: ['get', `${repository}/pullrequests`, [200], 'page'],
  pullRequest: ['get', review, [200], 'json'],
  diff: ['get', `${repository}/diff/{spec}`, [200], 'text'],
  diffstat: ['get', `${repository}/diffstat/{spec}`, [200], 'page'],
  file: ['get', `${repository}/src/{commit}/{path}`, [200], 'text'],
  fileMetadata: ['get', `${repository}/src/{commit}/{path}`, [200], 'json'],
  commit: ['get', `${repository}/commit/{commit}`, [200], 'json'],
  commits: ['get', `${review}/commits`, [200], 'page'],
  statuses: ['get', `${review}/statuses`, [200], 'page'],
  commitStatuses: ['get', `${repository}/commit/{commit}/statuses`, [200], 'page'],
  comments: ['get', comments, [200], 'page'],
  comment: ['get', comment, [200], 'json'],
  createComment: ['post', comments, [201], 'json'],
  updateComment: ['put', comment, [200], 'json'],
  deleteComment: ['delete', comment, [204], 'json'],
  resolveComment: ['post', `${comment}/resolve`, [200], 'json'],
  reopenComment: ['delete', `${comment}/resolve`, [204], 'json'],
  approve: ['post', `${review}/approve`, [200], 'json'],
  unapprove: ['delete', `${review}/approve`, [204], 'json'],
  requestChanges: ['post', `${review}/request-changes`, [200], 'json'],
  removeChangeRequest: ['delete', `${review}/request-changes`, [204], 'json'],
  merge: ['post', `${review}/merge`, [200, 202], 'json'],
  mergeTask: ['get', `${review}/merge/task-status/{task_id}`, [200], 'json'],
} as const satisfies Record<string, readonly [string, keyof paths, readonly number[], string]>;

export type BitbucketInteractiveOperation = keyof typeof operations;
type Protocol<K extends BitbucketInteractiveOperation> = NonNullable<
  paths[(typeof operations)[K][1]][(typeof operations)[K][0]]
>;
const canonicalUuid = z.string().refine(value => normalizeBitbucketUuid(value) === value);
export const BitbucketInteractiveSourceSelectorSchema = z.strictObject({
  pullRequestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workspaceUuid: canonicalUuid,
  repositoryUuid: canonicalUuid,
});
export type BitbucketInteractiveSourceSelector = z.infer<
  typeof BitbucketInteractiveSourceSelectorSchema
>;
export type BitbucketInteractiveRequest<
  K extends BitbucketInteractiveOperation = BitbucketInteractiveOperation,
> = K extends BitbucketInteractiveOperation
  ? {
      operation: K;
      // Bitbucket's global fields parameter expands condensed PR repository identities.
      // https://developer.atlassian.com/cloud/bitbucket/rest/intro/#partial-response
      params: K extends 'pullRequest'
        ? Omit<Protocol<K>['parameters'], 'query'> & { query?: { fields?: string } }
        : Protocol<K>['parameters'];
      next?: string;
    } & RequestBodyOption<Protocol<K>>
  : never;
// The broker alone resolves this selector. Paths still identify the authorized destination;
// path.commit pins the expected full source SHA. Omission retains destination-only behavior.
export type BitbucketInteractiveBrokerRequest<
  K extends BitbucketInteractiveOperation = BitbucketInteractiveOperation,
> = K extends BitbucketInteractiveOperation
  ? BitbucketInteractiveRequest<K> & {
      source?: K extends 'file' | 'fileMetadata' ? BitbucketInteractiveSourceSelector : never;
    }
  : never;
type ProtocolData<K extends BitbucketInteractiveOperation> = NonNullable<
  FetchResponse<Protocol<K>, object, 'application/json'>['data']
>;
// format=meta returns a tree entry, not the endpoint's declared directory page.
// The endpoint documents attributes as an array, but commit_file declares only its element enum.
type FileMetadata = components['schemas']['treeentry'] &
  (
    | (Pick<components['schemas']['commit_file'], 'escaped_path'> & {
        type: 'commit_file';
        attributes?: NonNullable<components['schemas']['commit_file']['attributes']>[];
        size?: number;
      })
    | { type: 'commit_directory' }
  );
export type BitbucketInteractiveData<K extends BitbucketInteractiveOperation> = K extends
  | 'diff'
  | 'file'
  ? string
  : K extends 'fileMetadata'
    ? FileMetadata
    : [ProtocolData<K>] extends [never]
      ? unknown
      : ProtocolData<K>;
export type BitbucketInteractiveResult<T = unknown> =
  | { status: 200 | 201; data: T; next?: string; location?: string }
  | { status: 202; data: unknown; location: string }
  | { status: 204; data: null };

// Kilo IDs come from verified claims; provider identity and grants come from the selected integration.
export const BitbucketInteractiveMetadataSchema = z.strictObject({
  actorUserId: z.string().min(1),
  organizationId: z.string().min(1),
  integrationId: z.string().min(1),
  instanceUrl: z.literal('https://bitbucket.org'),
  providerActor: z.discriminatedUnion('credentialKind', [
    z.strictObject({
      credentialKind: z.literal('bitbucketOAuth'),
      actor: ReviewActorSchema.extend({
        provider: z.literal('bitbucket'),
        instanceUrl: z.literal('https://bitbucket.org'),
      }),
    }),
    // A workspace token identifies a workspace principal, not a provider user.
    z.strictObject({
      credentialKind: z.literal('bitbucketWorkspaceToken'),
      workspaceUuid: z.string().refine(value => normalizeBitbucketUuid(value) !== null),
      workspaceSlug: z.string().min(1),
    }),
  ]),
  grants: z.strictObject({
    scopes: z.array(
      z.enum([
        'account',
        'email',
        'repository',
        'repository:write',
        'pullrequest',
        'pullrequest:write',
        'webhook',
      ])
    ),
  }),
});
export type BitbucketInteractiveMetadata = z.infer<typeof BitbucketInteractiveMetadataSchema>;
export type BitbucketInteractiveServiceSuccess<T = unknown> = {
  success: true;
  result: BitbucketInteractiveResult<T>;
  metadata: BitbucketInteractiveMetadata;
};
export type BitbucketInteractiveResponse<T = unknown> = BitbucketInteractiveResult<T> & {
  metadata: BitbucketInteractiveMetadata;
};

export type BitbucketInteractiveScope =
  | { kind: 'workspace'; workspace: string }
  | { kind: 'repository'; workspace: string; repository: string };

// Only discovery/review filters and bounded pagination belong on these authenticated requests.
// In particular, OAuth query credentials must not override the server-selected actor.
const queryNames = new Set([
  'kind',
  'pattern',
  'q',
  'sort',
  'role',
  'state',
  'fields',
  'context',
  'path',
  'ignore_whitespace',
  'binary',
  'renames',
  'merge',
  'topic',
  'format',
  'max_depth',
  'refname',
  'async',
  'page',
  'pagelen',
  'cursor',
  'after',
  'before',
]);
const parameter = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]);
export const BitbucketInteractiveRequestSchema = z.strictObject({
  operation: z.custom<BitbucketInteractiveOperation>(
    value => typeof value === 'string' && Object.hasOwn(operations, value)
  ),
  params: z.strictObject({
    path: z.record(z.string(), z.union([z.string().min(1), z.number().int().positive()])),
    query: z
      .record(
        z.string().refine(name => queryNames.has(name)),
        parameter
      )
      .optional(),
  }),
  body: z.json().optional(),
  next: z.string().min(1).max(4096).optional(),
});
export const BitbucketInteractiveBrokerRequestSchema = BitbucketInteractiveRequestSchema.extend({
  source: BitbucketInteractiveSourceSelectorSchema.optional(),
}).refine(
  request =>
    request.source === undefined ||
    ((request.operation === 'file' || request.operation === 'fileMetadata') &&
      request.body === undefined &&
      request.next === undefined &&
      request.params.query === undefined &&
      typeof request.params.path.commit === 'string' &&
      /^[0-9a-fA-F]{40}$/.test(request.params.path.commit))
);
const pageSchema = z
  .object({
    values: z.array(z.unknown()).max(50),
    pagelen: z.number().int().positive().max(50).optional(),
    next: z.string().min(1).max(4096).optional(),
  })
  .refine(page => page.values.length <= (page.pagelen ?? 50));

function pageScope(url: URL): string {
  const params = new URLSearchParams(url.search);
  for (const name of ['page', 'cursor', 'after', 'before']) params.delete(name);
  params.sort();
  return params.toString();
}

function validatePageUrl(value: string, initial: URL): URL {
  try {
    const next = assertBitbucketUrl(value, initial.pathname);
    if (value.length > 4096 || pageScope(next) !== pageScope(initial)) throw new Error('scope');
    for (const name of ['page', 'pagelen', 'cursor', 'after', 'before']) {
      if (next.searchParams.getAll(name).length > 1) throw new Error('duplicate');
    }
    const page = next.searchParams.get('page');
    if (page !== null && /^\d+$/.test(page) && (Number(page) < 1 || Number(page) > 100))
      throw new Error('page');
    return next;
  } catch {
    throw new BitbucketInteractiveError('invalid_pagination');
  }
}

function validIdentity(value: string): boolean {
  return (
    normalizeBitbucketUuid(value) !== null ||
    (value.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..')
  );
}

// The credential owner authorizes this exact scope and retains refresh/invalidation ownership.
// A call performs one request. The operation ledger, never the SDK, decides write retries.
export function createBitbucketInteractiveApi(options: {
  scope: BitbucketInteractiveScope;
  accessToken: string;
  // Server-verified aliases for 202 merge-task locations only, never request paths.
  canonicalTaskRepository?: { workspace: string; repository: string };
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}) {
  const canonicalTaskRepository = options.canonicalTaskRepository;
  if (
    !validIdentity(options.scope.workspace) ||
    (options.scope.kind === 'repository' && !validIdentity(options.scope.repository)) ||
    (canonicalTaskRepository &&
      (options.scope.kind !== 'repository' ||
        normalizeBitbucketUuid(options.scope.workspace) === null ||
        normalizeBitbucketUuid(options.scope.repository) === null ||
        !validIdentity(canonicalTaskRepository.workspace) ||
        !validIdentity(canonicalTaskRepository.repository)))
  ) {
    throw new BitbucketInteractiveError('invalid_request');
  }

  async function run<K extends BitbucketInteractiveOperation>(
    input: BitbucketInteractiveRequest<K>,
    stream = false
  ): Promise<BitbucketInteractiveResult<BitbucketInteractiveData<K> | ReadableStream<Uint8Array>>> {
    try {
      assertBitbucketRequestSize(JSON.stringify(input), BITBUCKET_INTERACTIVE_REQUEST_MAX_BYTES);
      const parsed = BitbucketInteractiveRequestSchema.safeParse(input);
      if (!parsed.success) throw new BitbucketInteractiveError('invalid_request');
      const request = parsed.data;
      const [method, path, statuses, representation] = operations[request.operation];
      const pathParams = request.params.path;
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      if (
        names.some(name => !(name in pathParams)) ||
        Object.keys(pathParams).some(name => !names.includes(name))
      ) {
        throw new BitbucketInteractiveError('invalid_request');
      }
      for (const [name, value] of Object.entries(pathParams)) {
        if (name === 'pull_request_id' || name === 'comment_id') {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
            throw new BitbucketInteractiveError('invalid_request');
          }
        } else if (
          typeof value !== 'string' ||
          value.includes('\\') ||
          value.split('/').some(part => !part || part === '.' || part === '..')
        ) {
          throw new BitbucketInteractiveError('invalid_request');
        }
      }
      if (
        pathParams.workspace !== options.scope.workspace ||
        (request.operation === 'repositories'
          ? options.scope.kind !== 'workspace'
          : options.scope.kind !== 'repository' ||
            pathParams.repo_slug !== options.scope.repository)
      ) {
        throw new BitbucketInteractiveError('invalid_request');
      }
      if ((stream && representation !== 'text') || (request.next && representation !== 'page'))
        throw new BitbucketInteractiveError('invalid_request');
      const acceptsBody = ['createComment', 'updateComment', 'merge'].includes(request.operation);
      if (
        request.body !== undefined &&
        (!acceptsBody ||
          request.body === null ||
          typeof request.body !== 'object' ||
          Array.isArray(request.body))
      ) {
        throw new BitbucketInteractiveError('invalid_request');
      }
      if (
        (request.operation === 'createComment' || request.operation === 'updateComment') &&
        request.body === undefined
      ) {
        throw new BitbucketInteractiveError('invalid_request');
      }
      if (request.operation === 'file' && request.params.query?.format !== undefined)
        throw new BitbucketInteractiveError('invalid_request');
      const query = {
        ...request.params.query,
        ...(representation === 'page' ? { pagelen: 50 } : {}),
        ...(request.operation === 'fileMetadata' ? { format: 'meta' } : {}),
      };
      let next: string | undefined;
      let location: string | undefined;
      let status: number | undefined;
      const sdk = createClient<paths>({
        baseUrl: BITBUCKET_API_ROOT,
        redirect: 'manual',
        fetch: async sdkRequest => {
          const initial = new URL(sdkRequest.url);
          if (representation === 'page') validatePageUrl(initial.href, initial);
          if (request.next === initial.href)
            throw new BitbucketInteractiveError('invalid_pagination');
          const endpoint = request.next
            ? validatePageUrl(request.next, initial).href
            : initial.href;
          const { response, signal } = await fetchBitbucket(endpoint, {
            accessToken: options.accessToken,
            resourcePath: initial.pathname,
            fetch: options.fetch,
            requestTimeoutMs: options.requestTimeoutMs,
            method: sdkRequest.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
            body: sdkRequest.body ? await sdkRequest.text() : undefined,
            maxRequestBytes: BITBUCKET_INTERACTIVE_REQUEST_MAX_BYTES,
            accept:
              request.operation === 'file'
                ? '*/*'
                : representation === 'text'
                  ? 'text/plain, text/x-diff, text/x-patch, application/octet-stream'
                  : 'application/json',
          });
          status = response.status;
          if (!statuses.some(accepted => accepted === response.status)) {
            void response.body?.cancel().catch(() => undefined);
            const code =
              response.status === 401
                ? 'authentication_rejected'
                : response.status === 403
                  ? 'insufficient_permissions'
                  : response.status === 404
                    ? 'not_found'
                    : response.status === 409
                      ? 'conflict'
                      : response.status === 429
                        ? 'rate_limited'
                        : response.status >= 500
                          ? 'provider_unavailable'
                          : 'request_failed';
            throw new BitbucketInteractiveError(code);
          }
          if (response.status === 204) return new Response(null, { status: 204 });
          const bytes = await readBoundedBitbucketBody(
            response,
            signal,
            response.status === 202 || representation === 'text'
          );
          const contentType = response.headers
            .get('content-type')
            ?.split(';')[0]
            .trim()
            .toLowerCase();
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
          let data: Record<string, unknown> | undefined;
          if (representation === 'text') {
            // Raw file media types come from extensions, not content. fileMetadata carries binary state.
            // The bounded UTF-8 decode above rejects invalid text without guessing from a filename.
            if (
              request.operation === 'file'
                ? !contentType
                : ![
                    'text/plain',
                    'text/x-diff',
                    'text/x-patch',
                    'application/octet-stream',
                  ].includes(contentType ?? '')
            )
              throw new BitbucketInteractiveError('invalid_response');
          } else if (response.status !== 202 || text.length > 0) {
            if (contentType !== 'application/json')
              throw new BitbucketInteractiveError('invalid_response');
            data = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
            // Merge task polling can return a provider error object with HTTP 200.
            if (data.type === 'error') throw new BitbucketInteractiveError('request_failed');
          }
          if (representation === 'page') {
            const page = pageSchema.parse(data);
            if (page.next) {
              next = validatePageUrl(page.next, initial).href;
              if (next === endpoint) throw new BitbucketInteractiveError('invalid_pagination');
            }
          }
          const candidate = response.headers.get('location');
          if (candidate !== undefined && candidate !== null) {
            try {
              if (typeof candidate !== 'string') throw new Error('location');
              const expected = new URL(endpoint);
              const task = new URL(candidate);
              assertBitbucketUrl(candidate, task.pathname);
              if (task.search !== '') throw new Error('location_query');
              const prefixes = [`${expected.pathname}/task-status/`];
              if (response.status === 202 && canonicalTaskRepository) {
                prefixes.push(
                  new URL(
                    `${BITBUCKET_API_ROOT}/repositories/${encodeURIComponent(canonicalTaskRepository.workspace)}/${encodeURIComponent(canonicalTaskRepository.repository)}/pullrequests/${pathParams.pull_request_id}/merge/task-status/`
                  ).pathname
                );
              }
              if (
                response.status === 202
                  ? !prefixes.some(
                      prefix =>
                        task.pathname.startsWith(prefix) &&
                        validIdentity(decodeURIComponent(task.pathname.slice(prefix.length)))
                    )
                  : task.pathname !== expected.pathname &&
                    !task.pathname.startsWith(`${expected.pathname}/`)
              )
                throw new Error('resource');
              location = task.href;
            } catch {
              throw new BitbucketInteractiveError('invalid_response');
            }
          }
          if (response.status === 202 && !location)
            throw new BitbucketInteractiveError('invalid_response');
          // Only the bounded body and status enter the SDK. Provider headers and credentials never escape.
          return new Response(bytes.length || representation === 'text' ? bytes : null, {
            status: response.status,
            headers: { 'content-type': contentType ?? 'application/json' },
          });
        },
      });
      const sdkOptions = {
        params: { path: pathParams, ...(Object.keys(query).length ? { query } : {}) },
        body: request.body,
        parseAs: representation === 'text' ? (stream ? 'stream' : 'text') : 'json',
      };
      // The map and path checks bind these dynamic parameters to each generated SDK operation.
      // Narrow the method first: openapi-fetch requires one concrete method for path inference.
      const result =
        method === 'get'
          ? await sdk.GET(path, sdkOptions as FetchOptions<NonNullable<paths[typeof path]['get']>>)
          : method === 'delete'
            ? await sdk.DELETE(
                path,
                sdkOptions as FetchOptions<NonNullable<paths[typeof path]['delete']>>
              )
            : method === 'post'
              ? await sdk.POST(
                  path,
                  sdkOptions as FetchOptions<NonNullable<paths[typeof path]['post']>>
                )
              : await sdk.PUT(
                  path,
                  sdkOptions as FetchOptions<NonNullable<paths[typeof path]['put']>>
                );
      if (status === 204) return { status, data: null };
      if (status === 202 && location) return { status, data: result.data ?? null, location };
      if (status !== 200 && status !== 201) throw new BitbucketInteractiveError('invalid_response');
      return {
        status,
        data: result.data as BitbucketInteractiveData<K> | ReadableStream<Uint8Array>,
        ...(next ? { next } : {}),
        ...(location ? { location } : {}),
      };
    } catch (error) {
      // Never retain SDK causes, provider text, request objects, or credential-bearing headers.
      throw new BitbucketInteractiveError(
        error instanceof BitbucketInteractiveError || error instanceof BitbucketApiError
          ? error.code
          : 'invalid_response'
      );
    }
  }

  return {
    execute: <K extends BitbucketInteractiveOperation>(request: BitbucketInteractiveRequest<K>) =>
      run(request) as Promise<BitbucketInteractiveResult<BitbucketInteractiveData<K>>>,
    stream: (request: BitbucketInteractiveRequest<'diff' | 'file'>) => run(request, true),
    async *pages<K extends BitbucketInteractiveOperation>(input: BitbucketInteractiveRequest<K>) {
      const parsed = BitbucketInteractiveRequestSchema.safeParse(input);
      if (!parsed.success || operations[parsed.data.operation][3] !== 'page')
        throw new BitbucketInteractiveError('invalid_request');
      const visited = new Set<string>();
      let request = input;
      let items = 0;
      let bytes = 0;
      for (let count = 0; count < 100; count += 1) {
        if (request.next) {
          if (visited.has(request.next)) throw new BitbucketInteractiveError('invalid_pagination');
          visited.add(request.next);
        }
        const result = await run(request);
        const page = pageSchema.safeParse(result.data);
        if (!page.success) throw new BitbucketInteractiveError('invalid_response');
        items += page.data.values.length;
        bytes += new TextEncoder().encode(JSON.stringify(result.data)).byteLength;
        const next = 'next' in result ? result.next : undefined;
        if (items > 5000 || (items === 5000 && next))
          throw new BitbucketInteractiveError('item_limit_exceeded');
        if (bytes > BITBUCKET_MAX_RESPONSE_BYTES)
          throw new BitbucketInteractiveError('response_too_large');
        yield result;
        if (!next) return;
        request = { ...input, next };
      }
      throw new BitbucketInteractiveError('page_limit_exceeded');
    },
  };
}
