#!/usr/bin/env bun

type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;
type DebugLogger = (event: string, fields?: Record<string, unknown>) => void;

type CliOptions = {
  args: string[];
  env: Record<string, string | undefined>;
  fetch?: FetchFunction;
  currentBranch?: () => Promise<string>;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
};

type TrustedRepository = {
  token: string;
  workspaceSlug: string;
  workspaceUuid: string;
  repositorySlug: string;
  repositoryUuid: string;
};

type PullRequestTarget = TrustedRepository & {
  pullRequestId: number;
};

type SummaryInput = { kind: 'summary'; body: string };
type FindingInput = { kind: 'finding'; body: string; path: string; line: number };
type CreateInput = SummaryInput | FindingInput;
type CreateBatchInput = FindingInput[];

type Command =
  | { kind: 'help' }
  | { kind: 'pr-current' }
  | {
      kind: 'pr-create';
      title: string;
      description?: string;
      destinationBranch?: string;
    }
  | { kind: 'pr-view'; pullRequestId: number }
  | { kind: 'pr-diff'; pullRequestId: number; nameOnly: boolean }
  | { kind: 'comments-list'; pullRequestId: number }
  | { kind: 'comments-create'; pullRequestId: number }
  | { kind: 'comments-create-batch'; pullRequestId: number }
  | { kind: 'comments-update'; pullRequestId: number; commentId: number };

class CliError extends Error {
  constructor(
    readonly code: string,
    readonly debugDetails?: Record<string, unknown>,
    readonly hint?: string
  ) {
    super(code);
  }
}

const API_ORIGIN = 'https://api.bitbucket.org';
const API_ROOT = `${API_ORIGIN}/2.0`;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_DIFF_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_DIFFSTAT_PAGES = 50;
const MAX_DIFFSTAT_FILES = 1000;
const MAX_DIFFSTAT_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_COMMENT_PAGES = 50;
const MAX_COMMENTS = 1000;
const MAX_COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_COMMENT_BODY_BYTES = 64 * 1024;
const MAX_BATCH_COMMENTS = 100;
const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const MAX_STDIN_BYTES = 128 * 1024;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROVIDER_UUID_PATTERN = new RegExp(`^(?:\\{(${UUID_PATTERN})\\}|(${UUID_PATTERN}))$`, 'i');
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();
const CREATE_COMMENT_INPUT_HINT =
  'expected create input JSON: {"body":"..."} or {"body":"...","inline":{"path":"src/widget.ts","to":42}}';
const CREATE_BATCH_COMMENT_INPUT_HINT =
  'expected batch create input JSON: {"comments":[{"body":"...","inline":{"path":"src/widget.ts","to":42}}]}';
const UPDATE_COMMENT_INPUT_HINT = 'expected update input JSON: {"body":"..."}';
const BITBUCKET_ENVIRONMENT_HINT =
  'expected Bitbucket cloud-agent environment: BITBUCKET_TOKEN, KILO_BITBUCKET_WORKSPACE_SLUG, KILO_BITBUCKET_WORKSPACE_UUID, KILO_BITBUCKET_REPOSITORY_SLUG, KILO_BITBUCKET_REPOSITORY_UUID';
const PR_CURRENT_COMMAND_HINT = 'expected PR current syntax: bb pr current';
const PR_CREATE_COMMAND_HINT =
  'expected PR create syntax: bb pr create --title <title> [--description <body>] [--destination <branch>]';
const PR_VIEW_COMMAND_HINT = 'expected PR view syntax: bb pr view <pull-request-id>';
const PR_DIFF_COMMAND_HINT = 'expected PR diff syntax: bb pr diff <pull-request-id> [--name-only]';
const COMMENTS_LIST_COMMAND_HINT =
  'expected comments list syntax: bb comments list <pull-request-id>';
const COMMENTS_CREATE_COMMAND_HINT = `expected comments create syntax: bb comments create <pull-request-id> --input -; ${CREATE_COMMENT_INPUT_HINT}`;
const COMMENTS_CREATE_BATCH_COMMAND_HINT = `expected comments create-batch syntax: bb comments create-batch <pull-request-id> --input -; ${CREATE_BATCH_COMMENT_INPUT_HINT}`;
const COMMENTS_UPDATE_COMMAND_HINT = `expected comments update syntax: bb comments update <pull-request-id> <comment-id> --input -; ${UPDATE_COMMENT_INPUT_HINT}`;
const SUMMARY_ALREADY_EXISTS_HINT =
  'existing Code Review Summary found; use bb comments update <pull-request-id> <comment-id> --input -';
const TOP_LEVEL_COMMAND_HINT = [
  'expected command: bb help',
  'bb pr current',
  'bb pr create --title <title> [--description <body>] [--destination <branch>]',
  'bb pr view <pull-request-id>',
  'bb pr diff <pull-request-id> [--name-only]',
  'bb comments list <pull-request-id>',
  'bb comments create <pull-request-id> --input -',
  'bb comments create-batch <pull-request-id> --input -',
  'bb comments update <pull-request-id> <comment-id> --input -',
].join(' | ');
const HELP_TEXT = `Usage: bb <command>

Syntax:
  bb help
  bb pr current
  bb pr create --title <title> [--description <body>] [--destination <branch>]
  bb pr view <pull-request-id>
  bb pr diff <pull-request-id> [--name-only]
  bb comments list <pull-request-id>
  bb comments create <pull-request-id> --input -
  bb comments create-batch <pull-request-id> --input -
  bb comments update <pull-request-id> <comment-id> --input -

Examples:
  bb pr current
  bb pr create --title "Add safer widgets" --description "Ready for review"
  bb pr view 42
  bb pr diff 42
  bb pr diff 42 --name-only
  bb comments list 42
  echo '{"body": "This is a test comment added via the bb CLI tool"}' | bb comments create 1 --input -
  echo '{"body": "Inline finding", "inline": {"path": "src/widget.ts", "to": 42}}' | bb comments create 1 --input -
  echo '{"comments": [{"body": "Inline finding", "inline": {"path": "src/widget.ts", "to": 42}}]}' | bb comments create-batch 1 --input -
  echo '{"body": "Updated summary"}' | bb comments update 1 123 --input -

Comment input:
  Create input must be {"body": "..."} or {"body": "...", "inline": {"path": "...", "to": 123}}.
  Batch create input must be {"comments": [{"body": "...", "inline": {"path": "...", "to": 123}}, ...]}.
  Update input must be {"body": "..."} only.

Environment:
  Provider-backed commands require BITBUCKET_TOKEN, KILO_BITBUCKET_WORKSPACE_SLUG,
  KILO_BITBUCKET_WORKSPACE_UUID, KILO_BITBUCKET_REPOSITORY_SLUG, and
  KILO_BITBUCKET_REPOSITORY_UUID.

Debug:
  Set BB_DEBUG=1 to print sanitized request and error metadata to stderr.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function debugValueType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new CliError('invalid_provider_response', {
      field: key,
      expected: 'string',
      actual: debugValueType(value),
    });
  }
  return value;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new CliError('invalid_provider_response', {
      field: key,
      expected: 'object',
      actual: debugValueType(value),
    });
  }
  return value;
}

function requiredEnvironmentValue(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) {
    throw new CliError('invalid_environment', undefined, BITBUCKET_ENVIRONMENT_HINT);
  }
  return value;
}

function canonicalBracedUuid(value: string, errorCode: string, hint?: string): string {
  const match = PROVIDER_UUID_PATTERN.exec(value);
  const uuid = match?.[1] ?? match?.[2];
  if (!uuid) {
    throw new CliError(
      errorCode,
      {
        expected: 'bitbucket_uuid',
        actualLength: value.length,
        hasBraces: value.startsWith('{') && value.endsWith('}'),
      },
      hint
    );
  }
  return `{${uuid.toLowerCase()}}`;
}

function normalizeUuid(value: string): string {
  return canonicalBracedUuid(value, 'invalid_provider_response');
}

function environmentUuid(value: string): string {
  return canonicalBracedUuid(value, 'invalid_environment', BITBUCKET_ENVIRONMENT_HINT);
}

function readTrustedRepository(env: Record<string, string | undefined>): TrustedRepository {
  const token = requiredEnvironmentValue(env, 'BITBUCKET_TOKEN');
  const workspaceSlug = requiredEnvironmentValue(env, 'KILO_BITBUCKET_WORKSPACE_SLUG');
  const workspaceUuid = environmentUuid(
    requiredEnvironmentValue(env, 'KILO_BITBUCKET_WORKSPACE_UUID')
  );
  const repositorySlug = requiredEnvironmentValue(env, 'KILO_BITBUCKET_REPOSITORY_SLUG');
  const repositoryUuid = environmentUuid(
    requiredEnvironmentValue(env, 'KILO_BITBUCKET_REPOSITORY_UUID')
  );

  if (
    token.length > 8192 ||
    hasAsciiControlCharacter(token) ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(workspaceSlug) ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(repositorySlug)
  ) {
    throw new CliError('invalid_environment', undefined, BITBUCKET_ENVIRONMENT_HINT);
  }

  return {
    token,
    workspaceSlug,
    workspaceUuid,
    repositorySlug,
    repositoryUuid,
  };
}

function pullRequestTarget(
  repository: TrustedRepository,
  pullRequestId: number
): PullRequestTarget {
  return { ...repository, pullRequestId };
}

function pullRequestUrl(target: PullRequestTarget): string {
  return `${API_ROOT}/repositories/${encodeURIComponent(target.workspaceSlug)}/${encodeURIComponent(target.repositorySlug)}/pullrequests/${target.pullRequestId}`;
}

function pullRequestsUrl(repository: TrustedRepository): string {
  return `${API_ROOT}/repositories/${encodeURIComponent(repository.workspaceSlug)}/${encodeURIComponent(repository.repositorySlug)}/pullrequests`;
}

function commentsUrl(target: PullRequestTarget): string {
  return `${pullRequestUrl(target)}/comments`;
}

function diffstatUrl(target: PullRequestTarget): string {
  return `${pullRequestUrl(target)}/diffstat`;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<{ text: string; byteLength: number }> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new CliError('invalid_provider_response');
    }
    if (declaredBytes > maximumBytes) throw new CliError('provider_response_too_large');
  }

  if (response.body === null) return { text: '', byteLength: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new CliError('provider_response_too_large');
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { text: textDecoder.decode(bytes), byteLength: totalBytes };
  } catch {
    throw new CliError('invalid_provider_response');
  }
}

function assertSuccessfulResponse(response: Response): void {
  if (response.status >= 300 && response.status < 400) throw new CliError('redirect_rejected');
  if (response.status === 401) throw new CliError('token_expired');
  if (response.status === 403) throw new CliError('access_denied');
  if (response.status === 404) throw new CliError('resource_not_found');
  if (response.status === 429) throw new CliError('rate_limited');
  if (response.status >= 500) throw new CliError('provider_unavailable');
  if (!response.ok) throw new CliError('provider_request_failed');
}

function requestHeaders(
  repository: TrustedRepository,
  accept: string,
  body?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    Authorization: `Bearer ${repository.token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

function createDebugLogger(enabled: boolean, stderr: (value: string) => void): DebugLogger {
  if (!enabled) return () => {};
  return (event, fields = {}) => {
    stderr(`bb debug: ${JSON.stringify({ event, ...fields })}\n`);
  };
}

function sanitizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function sanitizedRedirectLocation(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return {
      origin: url.origin,
      pathname: url.pathname,
      searchKeys: [...new Set(url.searchParams.keys())],
      fromPullRequestId: url.searchParams.get('from_pullrequest_id'),
      topic: url.searchParams.get('topic'),
    };
  } catch {
    return { parseable: false, length: value.length };
  }
}

function withDebugFetch(fetchFunction: FetchFunction, debug: DebugLogger): FetchFunction {
  return async (url, init) => {
    const method = init.method ?? 'GET';
    debug('provider_request', {
      method,
      url: sanitizedUrl(url),
    });
    try {
      const response = await fetchFunction(url, init);
      debug('provider_response', {
        method,
        url: sanitizedUrl(url),
        status: response.status,
        contentType: response.headers.get('Content-Type'),
        contentLength: response.headers.get('Content-Length'),
        location: sanitizedRedirectLocation(response.headers.get('Location')),
      });
      return response;
    } catch (error) {
      debug('provider_request_error', {
        method,
        url: sanitizedUrl(url),
        errorName: error instanceof Error ? error.name : debugValueType(error),
      });
      throw error;
    }
  };
}

async function fetchProvider(
  fetchFunction: FetchFunction,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchFunction(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CliError('provider_unavailable');
  }
}

type JsonResponse = { value: unknown; byteLength: number };

async function readJsonResponseBody(response: Response): Promise<JsonResponse> {
  const body = await readBoundedBody(response, MAX_JSON_RESPONSE_BYTES);
  try {
    return { value: JSON.parse(body.text), byteLength: body.byteLength };
  } catch {
    throw new CliError('invalid_provider_response', { expected: 'json' });
  }
}

async function requestJsonResponse(
  fetchFunction: FetchFunction,
  repository: TrustedRepository,
  url: string,
  request: { method: 'GET' | 'POST' | 'PUT'; body?: string; expectedStatus?: 200 | 201 } = {
    method: 'GET',
  }
): Promise<JsonResponse> {
  if (
    request.body !== undefined &&
    textEncoder.encode(request.body).byteLength > MAX_REQUEST_BODY_BYTES
  ) {
    throw new CliError('input_too_large');
  }
  const response = await fetchProvider(fetchFunction, url, {
    method: request.method,
    headers: requestHeaders(repository, 'application/json', request.body),
    body: request.body,
    redirect: 'manual',
  });
  assertSuccessfulResponse(response);
  if (request.expectedStatus !== undefined && response.status !== request.expectedStatus) {
    throw new CliError('invalid_provider_response');
  }
  return await readJsonResponseBody(response);
}

async function requestJson(
  fetchFunction: FetchFunction,
  repository: TrustedRepository,
  url: string,
  request?: { method: 'GET' | 'POST' | 'PUT'; body?: string; expectedStatus?: 200 | 201 }
): Promise<unknown> {
  return (await requestJsonResponse(fetchFunction, repository, url, request)).value;
}

function boundedProviderString(value: string, maximumBytes: number): string {
  if (value.includes('\u0000') || textEncoder.encode(value).byteLength > maximumBytes) {
    throw new CliError('invalid_provider_response');
  }
  return value;
}

function requiredBoundedString(
  record: Record<string, unknown>,
  key: string,
  maximumBytes: number
): string {
  const value = boundedProviderString(requiredString(record, key), maximumBytes);
  if (value.length === 0) throw new CliError('invalid_provider_response');
  return value;
}

function projectRepositoryIdentity(
  repository: Record<string, unknown>,
  target: PullRequestTarget
): { repositoryUuid: string; workspaceUuid: string } {
  const repositoryUuid = normalizeUuid(requiredString(repository, 'uuid'));
  const expectedFullName = `${target.workspaceSlug}/${target.repositorySlug}`;
  if (
    repositoryUuid !== target.repositoryUuid ||
    requiredBoundedString(repository, 'full_name', 511) !== expectedFullName
  ) {
    throw new CliError('repository_identity_mismatch');
  }

  const workspace = repository.workspace;
  if (workspace === undefined || workspace === null) {
    return { repositoryUuid, workspaceUuid: target.workspaceUuid };
  }
  if (!isRecord(workspace)) {
    throw new CliError('invalid_provider_response', {
      field: 'workspace',
      expected: 'object',
      actual: debugValueType(workspace),
    });
  }
  const workspaceUuid = normalizeUuid(requiredString(workspace, 'uuid'));
  if (
    workspaceUuid !== target.workspaceUuid ||
    requiredBoundedString(workspace, 'slug', 255) !== target.workspaceSlug
  ) {
    throw new CliError('repository_identity_mismatch');
  }

  return { repositoryUuid, workspaceUuid };
}

async function readPullRequest(
  fetchFunction: FetchFunction,
  target: PullRequestTarget
): Promise<unknown> {
  return await requestJson(fetchFunction, target, pullRequestUrl(target));
}

function validateBranchName(value: string): string {
  if (
    value.length === 0 ||
    textEncoder.encode(value).byteLength > 4096 ||
    value === 'HEAD' ||
    value.includes('"') ||
    value.includes('\\') ||
    hasAsciiControlCharacter(value)
  ) {
    throw new CliError('invalid_branch');
  }
  return value;
}

async function readCurrentBranchFromGit(): Promise<string> {
  const process = Bun.spawn(['git', 'branch', '--show-current'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new CliError('branch_unavailable');
  return validateBranchName(output.trim());
}

function currentPullRequestsUrl(repository: TrustedRepository, branch: string): string {
  const params = new URLSearchParams({
    q: `source.branch.name = "${branch}" AND state = "OPEN"`,
    pagelen: '50',
  });
  return `${pullRequestsUrl(repository)}?${params}`;
}

async function findOpenPullRequestForBranch(
  fetchFunction: FetchFunction,
  repository: TrustedRepository,
  branch: string
): Promise<unknown> {
  const value = await requestJson(
    fetchFunction,
    repository,
    currentPullRequestsUrl(repository, branch)
  );
  if (!isRecord(value) || !Array.isArray(value.values)) {
    throw new CliError('invalid_provider_response');
  }
  if (value.next !== undefined && value.next !== null)
    throw new CliError('pagination_limit_exceeded');

  const pullRequests = value.values.filter(pullRequest => {
    if (!isRecord(pullRequest) || pullRequest.state !== 'OPEN') return false;
    const source = pullRequest.source;
    if (!isRecord(source)) return false;
    const sourceBranch = source.branch;
    if (!isRecord(sourceBranch)) return false;
    return sourceBranch.name === branch;
  });

  if (pullRequests.length > 1) throw new CliError('ambiguous_pull_request');
  return pullRequests[0] ?? null;
}

function normalizeCliText(value: string, maximumBytes: number): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (
    normalized.length === 0 ||
    normalized.includes('\u0000') ||
    textEncoder.encode(normalized).byteLength > maximumBytes
  ) {
    throw new CliError('invalid_input');
  }
  return normalized;
}

async function createPullRequest(
  fetchFunction: FetchFunction,
  repository: TrustedRepository,
  input: {
    title: string;
    description?: string;
    sourceBranch: string;
    destinationBranch?: string;
  }
): Promise<unknown> {
  const destinationBranch =
    input.destinationBranch === undefined ? undefined : validateBranchName(input.destinationBranch);
  const body = serializeRequestBody({
    title: normalizeCliText(input.title, 4096),
    ...(input.description === undefined
      ? {}
      : { description: normalizeCliText(input.description, MAX_COMMENT_BODY_BYTES) }),
    source: { branch: { name: input.sourceBranch } },
    ...(destinationBranch === undefined
      ? {}
      : { destination: { branch: { name: destinationBranch } } }),
  });

  return await requestJson(fetchFunction, repository, pullRequestsUrl(repository), {
    method: 'POST',
    body,
    expectedStatus: 201,
  });
}

async function assertWritablePullRequest(
  fetchFunction: FetchFunction,
  target: PullRequestTarget
): Promise<void> {
  const value = await requestJson(fetchFunction, target, pullRequestUrl(target));
  if (!isRecord(value)) throw new CliError('invalid_provider_response');
  const state = value.state;
  const draft = value.draft;
  if (
    value.id !== target.pullRequestId ||
    typeof draft !== 'boolean' ||
    (state !== 'OPEN' && state !== 'MERGED' && state !== 'DECLINED' && state !== 'SUPERSEDED')
  ) {
    throw new CliError('invalid_provider_response');
  }
  projectRepositoryIdentity(
    requiredRecord(requiredRecord(value, 'destination'), 'repository'),
    target
  );
  if (state !== 'OPEN' || draft) throw new CliError('pull_request_not_writable');
}

function diffRequest(repository: TrustedRepository, accept = 'text/plain'): RequestInit {
  return {
    method: 'GET',
    headers: requestHeaders(repository, accept),
    redirect: 'manual',
  };
}

function validatedPullRequestRedirect(
  response: Response,
  target: PullRequestTarget,
  targetResource: 'diff' | 'diffstat'
): string {
  const location = response.headers.get('Location');
  if (response.status !== 302 || location === null || location.length > 8192) {
    throw new CliError('redirect_rejected');
  }

  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new CliError('redirect_rejected');
  }
  const expectedPathPrefix = `/2.0/repositories/${target.workspaceSlug}/${target.repositorySlug}/${targetResource}/`;
  if (
    url.origin !== API_ORIGIN ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !url.pathname.startsWith(expectedPathPrefix)
  ) {
    throw new CliError('redirect_rejected');
  }

  const encodedSpec = url.pathname.slice(expectedPathPrefix.length);
  if (encodedSpec.length === 0 || encodedSpec.length > 4096) {
    throw new CliError('redirect_rejected');
  }

  const redirectedPullRequestIds = url.searchParams.getAll('from_pullrequest_id');
  if (
    redirectedPullRequestIds.length > 1 ||
    (redirectedPullRequestIds.length === 1 &&
      redirectedPullRequestIds[0] !== String(target.pullRequestId))
  ) {
    throw new CliError('redirect_rejected');
  }
  return url.toString();
}

function validatedDiffRedirect(response: Response, target: PullRequestTarget): string {
  return validatedPullRequestRedirect(response, target, 'diff');
}

function validatedDiffstatRedirect(response: Response, target: PullRequestTarget): string {
  return validatedPullRequestRedirect(response, target, 'diffstat');
}

async function requestDiff(
  fetchFunction: FetchFunction,
  target: PullRequestTarget
): Promise<string> {
  let response = await fetchProvider(
    fetchFunction,
    `${pullRequestUrl(target)}/diff`,
    diffRequest(target)
  );
  if (response.status >= 300 && response.status < 400) {
    response = await fetchProvider(
      fetchFunction,
      validatedDiffRedirect(response, target),
      diffRequest(target)
    );
  }
  assertSuccessfulResponse(response);
  return (await readBoundedBody(response, MAX_DIFF_RESPONSE_BYTES)).text;
}

function validatedInlinePath(value: unknown, errorCode: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > 4096 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    hasAsciiControlCharacter(value) ||
    value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new CliError(errorCode);
  }
  return value;
}

function diffstatPath(value: unknown): string {
  if (!isRecord(value)) throw new CliError('invalid_provider_response');

  const newFile = value.new;
  if (isRecord(newFile) && newFile.path !== undefined && newFile.path !== null) {
    return validatedInlinePath(newFile.path, 'invalid_provider_response');
  }

  const oldFile = value.old;
  if (isRecord(oldFile) && oldFile.path !== undefined && oldFile.path !== null) {
    return validatedInlinePath(oldFile.path, 'invalid_provider_response');
  }

  throw new CliError('invalid_provider_response');
}

function validatePaginationUrl(value: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('invalid_pagination');
  }
  if (
    url.origin !== API_ORIGIN ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.pathname !== expectedPath
  ) {
    throw new CliError('invalid_pagination');
  }

  if (url.searchParams.getAll('page').length > 1 || url.searchParams.getAll('pagelen').length > 1) {
    throw new CliError('invalid_pagination');
  }
  const page = url.searchParams.get('page');
  if (page !== null && (!/^[1-9][0-9]*$/.test(page) || !Number.isSafeInteger(Number(page)))) {
    throw new CliError('invalid_pagination');
  }
  return url.toString();
}

async function listComments(
  fetchFunction: FetchFunction,
  target: PullRequestTarget
): Promise<unknown[]> {
  const baseUrl = commentsUrl(target);
  const expectedPath = new URL(baseUrl).pathname;
  const visitedUrls = new Set<string>();
  const comments: unknown[] = [];
  let totalBytes = 0;
  let nextUrl: string | null = `${baseUrl}?pagelen=100`;

  for (let page = 0; nextUrl !== null; page += 1) {
    if (page >= MAX_COMMENT_PAGES || visitedUrls.has(nextUrl)) {
      throw new CliError('pagination_limit_exceeded');
    }
    visitedUrls.add(nextUrl);
    const result = await requestJsonResponse(fetchFunction, target, nextUrl);
    totalBytes += result.byteLength;
    if (totalBytes > MAX_COMMENT_TOTAL_BYTES) {
      throw new CliError('pagination_limit_exceeded');
    }
    if (!isRecord(result.value) || !Array.isArray(result.value.values)) {
      throw new CliError('invalid_provider_response');
    }
    if (
      result.value.values.length > MAX_COMMENTS_PER_PAGE ||
      comments.length + result.value.values.length > MAX_COMMENTS
    ) {
      throw new CliError('pagination_limit_exceeded');
    }
    for (const comment of result.value.values) {
      comments.push(comment);
    }

    const next = result.value.next;
    if (next === undefined || next === null) {
      nextUrl = null;
    } else if (typeof next === 'string') {
      nextUrl = validatePaginationUrl(next, expectedPath);
    } else {
      throw new CliError('invalid_provider_response');
    }
  }
  return comments;
}

async function listChangedFilePaths(
  fetchFunction: FetchFunction,
  target: PullRequestTarget
): Promise<string[]> {
  const response = await fetchProvider(fetchFunction, diffstatUrl(target), {
    ...diffRequest(target, 'application/json'),
    redirect: 'manual',
  });

  let nextUrl: string | null;
  let pendingResult: JsonResponse | null = null;
  let expectedPath = new URL(diffstatUrl(target)).pathname;

  if (response.status >= 300 && response.status < 400) {
    nextUrl = validatedDiffstatRedirect(response, target);
    expectedPath = new URL(nextUrl).pathname;
  } else {
    assertSuccessfulResponse(response);
    pendingResult = await readJsonResponseBody(response);
    nextUrl = null;
  }

  const seenPaths = new Set<string>();
  const paths: string[] = [];
  let totalBytes = 0;

  for (let page = 0; page < MAX_DIFFSTAT_PAGES; page += 1) {
    if (pendingResult === null && nextUrl === null) break;

    let result: JsonResponse;
    if (pendingResult !== null) {
      result = pendingResult;
      pendingResult = null;
    } else if (nextUrl !== null) {
      result = await requestJsonResponse(fetchFunction, target, nextUrl);
    } else {
      break;
    }
    totalBytes += result.byteLength;
    if (totalBytes > MAX_DIFFSTAT_TOTAL_BYTES) throw new CliError('pagination_limit_exceeded');
    if (!isRecord(result.value) || !Array.isArray(result.value.values)) {
      throw new CliError('invalid_provider_response');
    }
    if (
      result.value.values.length > MAX_COMMENTS_PER_PAGE ||
      paths.length + result.value.values.length > MAX_DIFFSTAT_FILES
    ) {
      throw new CliError('pagination_limit_exceeded');
    }

    for (const entry of result.value.values) {
      const path = diffstatPath(entry);
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        paths.push(path);
      }
    }

    const next = result.value.next;
    if (next === undefined || next === null) {
      nextUrl = null;
    } else if (typeof next === 'string') {
      nextUrl = validatePaginationUrl(next, expectedPath);
    } else {
      throw new CliError('invalid_provider_response');
    }
  }

  if (nextUrl !== null) throw new CliError('pagination_limit_exceeded');
  return paths;
}

async function readInput(stream: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > MAX_STDIN_BYTES) {
      await reader.cancel();
      throw new CliError('input_too_large');
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new CliError('invalid_input');
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeInputBody(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) throw new CliError('invalid_input');
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) throw new CliError('invalid_input');
  if (textEncoder.encode(normalized).byteLength > MAX_COMMENT_BODY_BYTES) {
    throw new CliError('input_too_large');
  }
  return normalized;
}

function parseCreateInput(value: unknown): CreateInput {
  if (!isRecord(value)) throw new CliError('invalid_input');
  const body = normalizeInputBody(value.body);
  if (hasExactKeys(value, ['body'])) return { kind: 'summary', body };
  if (!hasExactKeys(value, ['body', 'inline']) || !isRecord(value.inline)) {
    throw new CliError('invalid_input');
  }
  if (!hasExactKeys(value.inline, ['path', 'to'])) throw new CliError('invalid_input');
  const line = value.inline.to;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line <= 0) {
    throw new CliError('invalid_input');
  }
  return {
    kind: 'finding',
    body,
    path: validatedInlinePath(value.inline.path, 'invalid_input'),
    line,
  };
}

function parseCreateBatchInput(value: unknown): CreateBatchInput {
  if (!isRecord(value) || !hasExactKeys(value, ['comments']) || !Array.isArray(value.comments)) {
    throw new CliError('invalid_input');
  }
  if (value.comments.length === 0 || value.comments.length > MAX_BATCH_COMMENTS) {
    throw new CliError('invalid_input');
  }
  const comments: FindingInput[] = [];
  for (const comment of value.comments) {
    const parsed = parseCreateInput(comment);
    if (parsed.kind !== 'finding') throw new CliError('invalid_input');
    comments.push(parsed);
  }
  return comments;
}

function parseUpdateInput(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ['body'])) throw new CliError('invalid_input');
  return normalizeInputBody(value.body);
}

async function readCommentInput(
  stdin: ReadableStream<Uint8Array>,
  parse: (value: unknown) => CreateInput,
  hint: string
): Promise<CreateInput>;
async function readCommentInput(
  stdin: ReadableStream<Uint8Array>,
  parse: (value: unknown) => CreateBatchInput,
  hint: string
): Promise<CreateBatchInput>;
async function readCommentInput(
  stdin: ReadableStream<Uint8Array>,
  parse: (value: unknown) => string,
  hint: string
): Promise<string>;
async function readCommentInput<T>(
  stdin: ReadableStream<Uint8Array>,
  parse: (value: unknown) => T,
  hint: string
): Promise<T> {
  try {
    return parse(await readInput(stdin));
  } catch (error) {
    if (error instanceof CliError && error.code === 'invalid_input') {
      throw new CliError(error.code, error.debugDetails, hint);
    }
    throw error;
  }
}

function serializeRequestBody(value: Record<string, unknown>): string {
  const body = JSON.stringify(value);
  if (textEncoder.encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new CliError('input_too_large');
  }
  return body;
}

function createCommentRequestBody(input: CreateInput): string {
  return serializeRequestBody(
    input.kind === 'finding'
      ? {
          content: { raw: input.body },
          inline: { path: input.path, to: input.line },
        }
      : { content: { raw: input.body } }
  );
}

function isTopLevelComment(value: Record<string, unknown>): boolean {
  return value.parent === undefined || value.parent === null;
}

function isCodeReviewSummaryBody(value: string): boolean {
  const body = value.trimStart();
  return (
    body.startsWith('## Code Review Summary') || body.includes('<!-- kilo-review:bitbucket:pr:')
  );
}

function isExistingCodeReviewSummaryComment(value: unknown): boolean {
  if (!isRecord(value) || value.deleted === true || !isTopLevelComment(value)) return false;
  const content = value.content;
  if (!isRecord(content) || typeof content.raw !== 'string') return false;
  return isCodeReviewSummaryBody(content.raw);
}

async function assertNoExistingSummaryComment(
  fetchFunction: FetchFunction,
  target: PullRequestTarget
): Promise<void> {
  const comments = await listComments(fetchFunction, target);
  if (comments.some(isExistingCodeReviewSummaryComment)) {
    throw new CliError('summary_already_exists', undefined, SUMMARY_ALREADY_EXISTS_HINT);
  }
}

async function createComment(
  fetchFunction: FetchFunction,
  target: PullRequestTarget,
  stdin: ReadableStream<Uint8Array>
): Promise<unknown> {
  const input = await readCommentInput(stdin, parseCreateInput, CREATE_COMMENT_INPUT_HINT);
  await assertWritablePullRequest(fetchFunction, target);
  if (input.kind === 'summary') {
    await assertNoExistingSummaryComment(fetchFunction, target);
  }
  return await requestJson(fetchFunction, target, commentsUrl(target), {
    method: 'POST',
    body: createCommentRequestBody(input),
    expectedStatus: 201,
  });
}

async function createCommentsBatch(
  fetchFunction: FetchFunction,
  target: PullRequestTarget,
  stdin: ReadableStream<Uint8Array>
): Promise<unknown[]> {
  const input = await readCommentInput(
    stdin,
    parseCreateBatchInput,
    CREATE_BATCH_COMMENT_INPUT_HINT
  );
  await assertWritablePullRequest(fetchFunction, target);

  const comments: unknown[] = [];
  for (const comment of input) {
    comments.push(
      await requestJson(fetchFunction, target, commentsUrl(target), {
        method: 'POST',
        body: createCommentRequestBody(comment),
        expectedStatus: 201,
      })
    );
  }
  return comments;
}

async function updateComment(
  fetchFunction: FetchFunction,
  target: PullRequestTarget,
  commentId: number,
  stdin: ReadableStream<Uint8Array>
): Promise<unknown> {
  const inputBody = await readCommentInput(stdin, parseUpdateInput, UPDATE_COMMENT_INPUT_HINT);
  const requestBody = serializeRequestBody({ content: { raw: inputBody } });
  await assertWritablePullRequest(fetchFunction, target);
  return await requestJson(fetchFunction, target, `${commentsUrl(target)}/${commentId}`, {
    method: 'PUT',
    body: requestBody,
    expectedStatus: 200,
  });
}

function positiveSafeInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function invalidCommand(hint: string): CliError {
  return new CliError('invalid_command', undefined, hint);
}

function parsePullRequestCreateCommand(args: string[]): Command | null {
  if (args[0] !== 'pr' || args[1] !== 'create') return null;

  let title: string | undefined;
  let description: string | undefined;
  let destinationBranch: string | undefined;

  for (let index = 2; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw invalidCommand(PR_CREATE_COMMAND_HINT);
    }

    switch (option) {
      case '--title':
        if (title !== undefined) throw invalidCommand(PR_CREATE_COMMAND_HINT);
        title = value;
        break;
      case '--description':
        if (description !== undefined) throw invalidCommand(PR_CREATE_COMMAND_HINT);
        description = value;
        break;
      case '--destination':
        if (destinationBranch !== undefined) throw invalidCommand(PR_CREATE_COMMAND_HINT);
        destinationBranch = value;
        break;
      default:
        throw invalidCommand(PR_CREATE_COMMAND_HINT);
    }
  }

  if (title === undefined) throw invalidCommand(PR_CREATE_COMMAND_HINT);
  return { kind: 'pr-create', title, description, destinationBranch };
}

function commandSyntaxHint(args: string[]): string {
  const [group, action] = args;
  if (group === 'pr') {
    switch (action) {
      case 'current':
        return PR_CURRENT_COMMAND_HINT;
      case 'create':
        return PR_CREATE_COMMAND_HINT;
      case 'view':
        return PR_VIEW_COMMAND_HINT;
      case 'diff':
        return PR_DIFF_COMMAND_HINT;
      default:
        return TOP_LEVEL_COMMAND_HINT;
    }
  }
  if (group === 'comments') {
    switch (action) {
      case 'list':
        return COMMENTS_LIST_COMMAND_HINT;
      case 'create':
        return COMMENTS_CREATE_COMMAND_HINT;
      case 'create-batch':
        return COMMENTS_CREATE_BATCH_COMMAND_HINT;
      case 'update':
        return COMMENTS_UPDATE_COMMAND_HINT;
      default:
        return TOP_LEVEL_COMMAND_HINT;
    }
  }
  return TOP_LEVEL_COMMAND_HINT;
}

function parseCommand(args: string[]): Command {
  if (
    args.length === 0 ||
    (args.length === 1 && (args[0] === 'help' || args[0] === '--help' || args[0] === '-h'))
  ) {
    return { kind: 'help' };
  }

  if (args.length === 2 && args[0] === 'pr' && args[1] === 'current') {
    return { kind: 'pr-current' };
  }

  const createCommand = parsePullRequestCreateCommand(args);
  if (createCommand) return createCommand;

  const pullRequestId = positiveSafeInteger(args[2]);
  if (args.length === 3 && args[0] === 'pr' && args[1] === 'view' && pullRequestId) {
    return { kind: 'pr-view', pullRequestId };
  }
  if (args[0] === 'pr' && args[1] === 'diff' && pullRequestId) {
    if (args.length === 3) return { kind: 'pr-diff', pullRequestId, nameOnly: false };
    if (args.length === 4 && args[3] === '--name-only') {
      return { kind: 'pr-diff', pullRequestId, nameOnly: true };
    }
  }
  if (args.length === 3 && args[0] === 'comments' && args[1] === 'list' && pullRequestId) {
    return { kind: 'comments-list', pullRequestId };
  }
  if (
    args.length === 5 &&
    args[0] === 'comments' &&
    args[1] === 'create' &&
    pullRequestId &&
    args[3] === '--input' &&
    args[4] === '-'
  ) {
    return { kind: 'comments-create', pullRequestId };
  }
  if (
    args.length === 5 &&
    args[0] === 'comments' &&
    args[1] === 'create-batch' &&
    pullRequestId &&
    args[3] === '--input' &&
    args[4] === '-'
  ) {
    return { kind: 'comments-create-batch', pullRequestId };
  }
  const updatePullRequestId = positiveSafeInteger(args[2]);
  const commentId = positiveSafeInteger(args[3]);
  if (
    args.length === 6 &&
    args[0] === 'comments' &&
    args[1] === 'update' &&
    updatePullRequestId &&
    commentId &&
    args[4] === '--input' &&
    args[5] === '-'
  ) {
    return { kind: 'comments-update', pullRequestId: updatePullRequestId, commentId };
  }
  throw invalidCommand(commandSyntaxHint(args));
}

export async function runBitbucketReviewCli(options: CliOptions): Promise<number> {
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  const stderr = options.stderr ?? (value => process.stderr.write(value));
  const debug = createDebugLogger(options.env.BB_DEBUG === '1', stderr);
  const fetchFunction = withDebugFetch(
    options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    debug
  );

  try {
    const command = parseCommand(options.args);
    if (command.kind === 'help') {
      stdout(HELP_TEXT);
      return 0;
    }

    const repository = readTrustedRepository(options.env);
    switch (command.kind) {
      case 'pr-current': {
        const currentBranch = options.currentBranch ?? readCurrentBranchFromGit;
        stdout(
          `${JSON.stringify({
            pullRequest: await findOpenPullRequestForBranch(
              fetchFunction,
              repository,
              validateBranchName(await currentBranch())
            ),
          })}\n`
        );
        return 0;
      }
      case 'pr-create': {
        const currentBranch = options.currentBranch ?? readCurrentBranchFromGit;
        const sourceBranch = validateBranchName(await currentBranch());
        const existingPullRequest = await findOpenPullRequestForBranch(
          fetchFunction,
          repository,
          sourceBranch
        );
        if (existingPullRequest !== null) {
          stdout(`${JSON.stringify({ created: false, pullRequest: existingPullRequest })}\n`);
          return 0;
        }
        stdout(
          `${JSON.stringify({
            created: true,
            pullRequest: await createPullRequest(fetchFunction, repository, {
              title: command.title,
              description: command.description,
              sourceBranch,
              destinationBranch: command.destinationBranch,
            }),
          })}\n`
        );
        return 0;
      }
      case 'pr-view':
        stdout(
          `${JSON.stringify(
            await readPullRequest(
              fetchFunction,
              pullRequestTarget(repository, command.pullRequestId)
            )
          )}\n`
        );
        return 0;
      case 'pr-diff':
        if (command.nameOnly) {
          const paths = await listChangedFilePaths(
            fetchFunction,
            pullRequestTarget(repository, command.pullRequestId)
          );
          stdout(paths.length === 0 ? '' : `${paths.join('\n')}\n`);
        } else {
          stdout(
            await requestDiff(fetchFunction, pullRequestTarget(repository, command.pullRequestId))
          );
        }
        return 0;
      case 'comments-list':
        stdout(
          `${JSON.stringify({
            comments: await listComments(
              fetchFunction,
              pullRequestTarget(repository, command.pullRequestId)
            ),
          })}\n`
        );
        return 0;
      case 'comments-create': {
        const stdin = options.stdin ?? Bun.stdin.stream();
        stdout(
          `${JSON.stringify(
            await createComment(
              fetchFunction,
              pullRequestTarget(repository, command.pullRequestId),
              stdin
            )
          )}\n`
        );
        return 0;
      }
      case 'comments-create-batch': {
        const stdin = options.stdin ?? Bun.stdin.stream();
        stdout(
          `${JSON.stringify({
            comments: await createCommentsBatch(
              fetchFunction,
              pullRequestTarget(repository, command.pullRequestId),
              stdin
            ),
          })}\n`
        );
        return 0;
      }
      case 'comments-update': {
        const stdin = options.stdin ?? Bun.stdin.stream();
        stdout(
          `${JSON.stringify(
            await updateComment(
              fetchFunction,
              pullRequestTarget(repository, command.pullRequestId),
              command.commentId,
              stdin
            )
          )}\n`
        );
        return 0;
      }
    }
  } catch (error) {
    const code = error instanceof CliError ? error.code : 'unexpected_failure';
    debug('command_error', {
      code,
      ...(error instanceof CliError ? (error.debugDetails ?? {}) : {}),
    });
    stderr(`bb: ${code}\n`);
    if (error instanceof CliError && error.hint) {
      stderr(`bb: ${error.hint}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runBitbucketReviewCli({ args: Bun.argv.slice(2), env: process.env });
}
