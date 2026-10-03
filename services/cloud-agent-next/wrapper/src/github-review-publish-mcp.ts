#!/usr/bin/env bun
import { z } from 'zod';
import { createInterface } from 'node:readline';
import {
  GITHUB_REVIEW_API_BASE_ENV,
  GITHUB_REVIEW_PUBLICATION_FAILURE_MARKER,
  GITHUB_REVIEW_SUMMARY_MARKER,
  GITHUB_REVIEW_TARGET_ENV,
  GITHUB_REVIEW_TOOL_NAME,
  parseGitHubReviewTarget,
  type GitHubReviewTarget,
} from '../../src/shared/github-review-target.js';

const GITHUB_COMMENT_MAX_CHARACTERS = 65_536;
const ISSUE_COMMENTS_PER_PAGE = 100;
const MAX_ISSUE_COMMENT_PAGES = 5;
const GITHUB_HTTP_TIMEOUT_MS = 15_000;
// Must stay inside the 90s wrapper recovery deadline so a hung publish ends
// before the wrapper aborts the session.
const PUBLICATION_TOTAL_TIMEOUT_MS = 75_000;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const PROTOCOL_VERSION_FALLBACK = '2024-11-05';

const HISTORY_BLOCK_PATTERN = /<!-- kilo-review-history -->[\s\S]*?<!-- \/kilo-review-history -->/g;
const COUNCIL_BLOCK_PATTERN =
  /<!-- kilo-council-verdict:start -->[\s\S]*?<!-- kilo-council-verdict:end -->/g;
const USAGE_FOOTER_MARKER = '<!-- kilo-usage -->';
const GUIDANCE_FOOTER_MARKER = '<!-- kilo-review-guidance -->';
const FOOTER_MARKERS = [USAGE_FOOTER_MARKER, GUIDANCE_FOOTER_MARKER];

export type GitHubReviewPublishErrorCode =
  | 'locked'
  | 'rate_limited'
  | 'scan_limit'
  | 'forbidden'
  | 'misconfigured'
  | 'rejected_body'
  | 'unverified';

export class GitHubReviewPublishError extends Error {
  readonly code: GitHubReviewPublishErrorCode;

  constructor(code: GitHubReviewPublishErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GitHubReviewPublishError';
    this.code = code;
  }
}

const GitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  user: z.object({ id: z.number() }).optional(),
  updated_at: z.string().optional(),
  html_url: z.string().optional(),
});

type GitHubComment = z.infer<typeof GitHubCommentSchema>;

function extractFooter(body: string): { text: string; start: number } | null {
  const markerIdx = Math.max(...FOOTER_MARKERS.map(marker => body.lastIndexOf(marker)));
  if (markerIdx === -1) return null;
  const before = body.slice(0, markerIdx);
  const matches = Array.from(before.matchAll(/(^|\n)([ \t]*---[ \t]*\n)/g));
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const start = (last.index ?? 0) + (last[1]?.length ?? 0);
  const footer = body.slice(start);
  if (!FOOTER_MARKERS.some(marker => footer.includes(marker))) return null;
  return { text: footer.trimEnd(), start };
}

function firstHistoryBlock(body: string): string | null {
  return body.match(HISTORY_BLOCK_PATTERN)?.[0] ?? null;
}

function firstCouncilBlock(body: string): string | null {
  return body.match(COUNCIL_BLOCK_PATTERN)?.[0] ?? null;
}

/**
 * Removes model-authored reserved blocks (history, council, usage/guidance
 * footer, publication-failure marker, and every summary marker) so only the
 * review wording remains.
 */
export function extractSummaryRemainder(body: string): string {
  let value = body.replace(HISTORY_BLOCK_PATTERN, '');
  value = value.replace(COUNCIL_BLOCK_PATTERN, '');
  const footer = extractFooter(value);
  if (footer) value = value.slice(0, footer.start);
  value = value.replaceAll(GITHUB_REVIEW_SUMMARY_MARKER, '');
  value = value.replaceAll(GITHUB_REVIEW_PUBLICATION_FAILURE_MARKER, '');
  return value.trim();
}

export type ComposedSummary = { ok: true; body: string } | { ok: false; reason: 'rejected_body' };

/**
 * Builds the exact body written to GitHub. A new comment is marker + wording; an
 * owned comment's trusted history, council, and footer blocks are preserved
 * verbatim after the new wording.
 */
export function composeReviewSummary(input: {
  modelBody: string;
  existingBody?: string;
}): ComposedSummary {
  const remainder = extractSummaryRemainder(input.modelBody);
  if (remainder.length === 0) return { ok: false, reason: 'rejected_body' };

  let composed = `${GITHUB_REVIEW_SUMMARY_MARKER}\n\n${remainder}`;
  if (input.existingBody !== undefined) {
    const council = firstCouncilBlock(input.existingBody);
    const history = firstHistoryBlock(input.existingBody);
    const footer = extractFooter(input.existingBody);
    if (council) composed += `\n\n${council}`;
    if (history) composed += `\n\n${history}`;
    if (footer) composed += `\n\n${footer.text}`;
  }
  if (composed.length > GITHUB_COMMENT_MAX_CHARACTERS) {
    return { ok: false, reason: 'rejected_body' };
  }
  return { ok: true, body: composed };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GitHubReviewPublisherDeps = {
  target: GitHubReviewTarget;
  token: string;
  fetchImpl: FetchLike;
  /** Trusted loopback base for the local harness, or null to force a failure. */
  apiBaseUrl: string | null;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

const LOOPBACK_API_BASE_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;

/**
 * The API base is a trusted, test-only injection. Any override that is not a
 * loopback origin is rejected with a misconfigured error rather than honored,
 * so a forged sandbox value cannot redirect the token or fake a verified
 * result. Without an override the real GitHub API is used.
 */
export function resolveApiBaseUrl(env: NodeJS.Dict<string>): string | null {
  const raw = env[GITHUB_REVIEW_API_BASE_ENV];
  if (typeof raw !== 'string' || raw.length === 0) return 'https://api.github.com';
  if (!LOOPBACK_API_BASE_PATTERN.test(raw)) return null;
  return raw.replace(/\/+$/, '');
}

function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kilocode-cloud-agent',
    'Content-Type': 'application/json',
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('message' in body)) return '';
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

export function createGitHubReviewPublisher(
  deps: GitHubReviewPublisherDeps
): (body: string, signal: AbortSignal) => Promise<{ commentId: number; url: string }> {
  const { target, token } = deps;

  async function request(
    method: string,
    path: string,
    options: { signal: AbortSignal; body?: unknown }
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal.aborted) controller.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), GITHUB_HTTP_TIMEOUT_MS);
    try {
      const init: RequestInit = {
        method,
        headers: githubHeaders(token),
        signal: controller.signal,
        redirect: 'error',
      };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      const response = await deps.fetchImpl(`${deps.apiBaseUrl}${path}`, init);
      const json = await readJson(response);
      return { status: response.status, headers: response.headers, json };
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  async function waitForRateLimit(
    response: { status: number; headers: Headers },
    signal: AbortSignal
  ): Promise<boolean> {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), Date.now());
    if (retryAfterMs === null || retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) return false;
    await deps.sleep(retryAfterMs, signal);
    return true;
  }

  async function performRequest(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { signal: AbortSignal; body?: unknown; retryAllowed: boolean }
  ): Promise<{ status: number; json: unknown }> {
    const response = await request(method, path, {
      signal: options.signal,
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.has('retry-after'))
    ) {
      const waited = options.retryAllowed
        ? await waitForRateLimit(response, options.signal)
        : false;
      if (!waited) throw new GitHubReviewPublishError('rate_limited');
      return performRequest(method, path, { ...options, retryAllowed: false });
    }
    if (response.status === 403) {
      throw new GitHubReviewPublishError(
        messageFromBody(response.json).toLowerCase().includes('lock') ? 'locked' : 'forbidden'
      );
    }
    if (response.status === 401 || response.status === 404) {
      throw new GitHubReviewPublishError('misconfigured', String(response.status));
    }
    if (response.status === 422) {
      throw new GitHubReviewPublishError('rejected_body');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubReviewPublishError('unverified', `status ${response.status}`);
    }
    return { status: response.status, json: response.json };
  }

  async function verifyComment(
    commentId: number,
    expectedBody: string,
    signal: AbortSignal
  ): Promise<{ commentId: number; url: string }> {
    const response = await request('GET', `/repos/${target.repo}/issues/comments/${commentId}`, {
      signal,
    });
    const parsed = GitHubCommentSchema.safeParse(response.json);
    if (
      !parsed.success ||
      parsed.data.id !== commentId ||
      (parsed.data.body ?? null) !== expectedBody ||
      String(parsed.data.user?.id ?? '') !== target.botUserId
    ) {
      throw new GitHubReviewPublishError('unverified');
    }
    return {
      commentId,
      url: parsed.data.html_url ?? `https://github.com/${target.repo}/issues/comments/${commentId}`,
    };
  }

  return async function publish(body, signal) {
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new GitHubReviewPublishError('rejected_body');
    }
    if (!token) throw new GitHubReviewPublishError('misconfigured');
    if (deps.apiBaseUrl === null) throw new GitHubReviewPublishError('misconfigured');

    const composedNew = composeReviewSummary({ modelBody: body });
    if (!composedNew.ok) throw new GitHubReviewPublishError('rejected_body');

    const comments: GitHubComment[] = [];
    let reachedScanLimit = false;
    for (let page = 1; page <= MAX_ISSUE_COMMENT_PAGES; page++) {
      if (signal.aborted) throw new GitHubReviewPublishError('unverified');
      const response = await performRequest(
        'GET',
        `/repos/${target.repo}/issues/${target.pullRequestNumber}/comments?per_page=${ISSUE_COMMENTS_PER_PAGE}&page=${page}`,
        { signal, retryAllowed: true }
      );
      const pageItems = Array.isArray(response.json) ? response.json : [];
      for (const item of pageItems) {
        const parsed = GitHubCommentSchema.safeParse(item);
        if (parsed.success) comments.push(parsed.data);
      }
      if (pageItems.length < ISSUE_COMMENTS_PER_PAGE) break;
      reachedScanLimit = page === MAX_ISSUE_COMMENT_PAGES;
    }

    const owned = comments.filter(comment => String(comment.user?.id ?? '') === target.botUserId);
    const ownedSummaries = owned.filter(comment =>
      (comment.body ?? '').includes(GITHUB_REVIEW_SUMMARY_MARKER)
    );
    const latestSummary = ownedSummaries.sort(
      (a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '')
    )[0];

    if (latestSummary) {
      const composed = composeReviewSummary({
        modelBody: body,
        existingBody: latestSummary.body ?? '',
      });
      if (!composed.ok) throw new GitHubReviewPublishError('rejected_body');
      const write = await performRequest(
        'PATCH',
        `/repos/${target.repo}/issues/comments/${latestSummary.id}`,
        { signal, body: { body: composed.body }, retryAllowed: true }
      );
      const parsed = GitHubCommentSchema.safeParse(write.json);
      const commentId = parsed.success ? parsed.data.id : latestSummary.id;
      return verifyComment(commentId, composed.body, signal);
    }

    const failureComment = owned.find(
      comment =>
        (comment.body ?? '').includes(GITHUB_REVIEW_PUBLICATION_FAILURE_MARKER) &&
        !(comment.body ?? '').includes(GITHUB_REVIEW_SUMMARY_MARKER)
    );
    if (failureComment) {
      const composed = composeReviewSummary({
        modelBody: body,
        existingBody: failureComment.body ?? '',
      });
      if (!composed.ok) throw new GitHubReviewPublishError('rejected_body');
      await performRequest('PATCH', `/repos/${target.repo}/issues/comments/${failureComment.id}`, {
        signal,
        body: { body: composed.body },
        retryAllowed: true,
      });
      return verifyComment(failureComment.id, composed.body, signal);
    }

    if (reachedScanLimit) {
      throw new GitHubReviewPublishError('scan_limit');
    }

    if (signal.aborted) throw new GitHubReviewPublishError('unverified');
    const write = await performRequest(
      'POST',
      `/repos/${target.repo}/issues/${target.pullRequestNumber}/comments`,
      { signal, body: { body: composedNew.body }, retryAllowed: true }
    );
    const parsed = GitHubCommentSchema.safeParse(write.json);
    if (!parsed.success) throw new GitHubReviewPublishError('unverified');
    return verifyComment(parsed.data.id, composedNew.body, signal);
  };
}

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
};

type PublishRuntime = {
  publish: (body: string, signal: AbortSignal) => Promise<{ commentId: number; url: string }>;
};

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcRequest['id'], value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value });
}

function errorResult(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolError(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text }], isError: true };
}

export async function githubReviewPublishMain(
  env: NodeJS.Dict<string> = process.env
): Promise<void> {
  const target = parseGitHubReviewTarget(env[GITHUB_REVIEW_TARGET_ENV]);
  const token = env.GH_TOKEN;
  const controllers = new Map<string, AbortController>();

  if (!target || !token) {
    process.stderr.write('github-review-publish-mcp: missing target or token\n');
  }

  const runtime: PublishRuntime =
    target && token
      ? {
          publish: createGitHubReviewPublisher({
            target,
            token,
            fetchImpl: fetch as FetchLike,
            apiBaseUrl: resolveApiBaseUrl(env),
            sleep: (ms, signal) =>
              new Promise<void>((resolve, reject) => {
                if (signal.aborted) return reject(new Error('aborted'));
                const timer = setTimeout(resolve, ms);
                signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                  },
                  { once: true }
                );
              }),
          }),
        }
      : {
          publish: async () => {
            throw new GitHubReviewPublishError('misconfigured');
          },
        };

  let mutex: Promise<unknown> = Promise.resolve();
  async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutex.then(operation);
    mutex = run.catch(() => {});
    return run;
  }

  async function handleCall(requestId: string, params: unknown): Promise<unknown> {
    const call = params as { name?: unknown; arguments?: unknown } | undefined;
    if (!call || call.name !== GITHUB_REVIEW_TOOL_NAME) {
      return toolError('misconfigured');
    }
    const args = (call.arguments ?? {}) as { body?: unknown };
    if (typeof args.body !== 'string') return toolError('rejected_body');

    const controller = new AbortController();
    controllers.set(requestId, controller);
    const totalTimer = setTimeout(() => controller.abort(), PUBLICATION_TOTAL_TIMEOUT_MS);
    try {
      const result = await runExclusive(() =>
        runtime.publish(args.body as string, controller.signal)
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              verified: true,
              commentId: result.commentId,
              url: result.url,
            }),
          },
        ],
      };
    } catch (error) {
      const code = error instanceof GitHubReviewPublishError ? error.code : ('unverified' as const);
      return toolError(code);
    } finally {
      clearTimeout(totalTimer);
      controllers.delete(requestId);
    }
  }

  function handleMessage(request: JsonRpcRequest): void {
    switch (request.method) {
      case 'initialize': {
        const params = request.params as { protocolVersion?: unknown } | undefined;
        const protocolVersion =
          typeof params?.protocolVersion === 'string'
            ? params.protocolVersion
            : PROTOCOL_VERSION_FALLBACK;
        result(request.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'code_review', version: '1.0.0' },
        });
        return;
      }
      case 'notifications/initialized':
        return;
      case 'notifications/cancelled': {
        const params = request.params as { requestId?: unknown } | undefined;
        const requestId = params?.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          controllers.get(String(requestId))?.abort();
        }
        return;
      }
      case 'tools/list':
        result(request.id, {
          tools: [
            {
              name: GITHUB_REVIEW_TOOL_NAME,
              description: 'Publish the code review summary comment to the bound pull request.',
              inputSchema: {
                type: 'object',
                properties: { body: { type: 'string' } },
                required: ['body'],
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      case 'tools/call': {
        void handleCall(String(request.id), request.params).then(value => {
          result(request.id, value);
        });
        return;
      }
      default:
        if (request.id !== undefined) {
          errorResult(request.id, -32601, `Method not found: ${request.method}`);
        }
    }
  }

  const reader = createInterface({ input: process.stdin });
  reader.on('line', line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !('method' in parsed)) return;
    handleMessage(parsed as JsonRpcRequest);
  });
  await new Promise<void>(resolve => reader.on('close', resolve));
}

if (import.meta.main) {
  void githubReviewPublishMain();
}
