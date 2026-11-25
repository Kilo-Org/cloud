import { z } from 'zod';
import { REVIEW_PUBLICATION_MAX_BYTES } from '@kilocode/worker-utils/scm-capability-contract';
import type { ReviewCapability } from './review-capability.js';
import { reviewOperation, type ReviewOperation } from './review-request-policy.js';
import { readBoundedJsonBody } from './lib/bounded-read.js';

type ReviewAccess = {
  redeem: () => Promise<Headers | null>;
  bitbucketAuthor?: { current(): Promise<string | null>; record(uuid: string): Promise<void> };
};
const marker = '<!-- kilo-review -->';
const bbHeading = '## Code Review Summary';
const number = z.number().int().positive();
const bbAuthor = z.object({ kind: z.literal('workspace_access_token'), uuid: z.string().min(1) });
const bbSummary = z.object({
  parent: z.null().optional(),
  inline: z.null().optional(),
  deleted: z.literal(false).optional(),
  user: bbAuthor,
  content: z.object({ raw: z.string() }),
});
function isSummary(value: unknown) {
  const parsed = bbSummary.safeParse(value);
  return parsed.success &&
    (parsed.data.content.raw.trimStart().startsWith(bbHeading) ||
      parsed.data.content.raw.includes('<!-- kilo-review:bitbucket:pr:'))
    ? parsed.data.user.uuid
    : null;
}

async function readProvider(url: string, headers: Headers) {
  const response = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 || !response.body) throw new Error('Review target unavailable');
  return readBoundedJsonBody(response.body, 1024 * 1024);
}

async function verifyTarget(
  scope: ReviewCapability,
  url: URL,
  headers: Headers,
  op: ReviewOperation,
  access: ReviewAccess
) {
  if (op === 'git' || op === 'read') return true;
  if (scope.provider === 'github') {
    if (op !== 'summary-edit' && op !== 'summary-read') return true;
    const comment = z
      .object({ issue_url: z.string(), user: z.object({ id: number }), body: z.string() })
      .parse(await readProvider(url.href, headers));
    return (
      comment.issue_url.toLowerCase() === scope.apiRoot.toLowerCase() + '/issues/' + scope.number &&
      String(comment.user.id) === scope.botId &&
      (comment.body.trimStart().startsWith(marker) ||
        comment.body.trimStart().startsWith('<!-- kilo-review-publication-failure -->'))
    );
  }
  if (scope.provider === 'gitlab') {
    if (op !== 'summary-edit') return true;
    const userUrl = scope.apiRoot.slice(0, scope.apiRoot.lastIndexOf('/projects/')) + '/user';
    const [actor, note] = await Promise.all([
      readProvider(userUrl, headers),
      readProvider(url.href, headers),
    ]);
    const user = z.object({ id: number }).parse(actor);
    const comment = z
      .object({ author: z.object({ id: number }), body: z.string(), system: z.literal(false) })
      .parse(note);
    return user.id === comment.author.id && comment.body.trimStart().startsWith(marker);
  }
  const pr = scope.apiRoot + '/pullrequests/' + scope.number;
  const current = z
    .object({
      id: number,
      state: z.literal('OPEN'),
      draft: z.literal(false),
      destination: z.object({ repository: z.object({ uuid: z.string() }) }),
      source: z.object({ commit: z.object({ hash: z.string() }) }),
    })
    .parse(await readProvider(pr, headers));
  if (
    current.id !== scope.number ||
    current.source.commit.hash !== scope.head ||
    current.destination.repository.uuid.replace(/[{}]/g, '').toLowerCase() !== scope.repositoryUuid
  )
    return false;
  if (op === 'summary-edit') {
    const owner = isSummary(await readProvider(url.href, headers));
    return owner !== null && owner === (await access.bitbucketAuthor?.current());
  }
  if (op === 'summary-create') {
    // Build each page URL locally. A provider-supplied next link must never receive the credential.
    for (let page = 1; page <= 50; page++) {
      const list = z
        .object({ values: z.array(z.unknown()), next: z.string().optional() })
        .parse(await readProvider(pr + '/comments?pagelen=100&page=' + page, headers));
      if (list.values.some(isSummary)) return false;
      if (!list.next) return true;
    }
    return false;
  }
  return true;
}

export async function forwardReviewRequest(
  scope: ReviewCapability,
  request: Request,
  access: ReviewAccess
): Promise<Response> {
  const deny = () => new Response('Review request denied', { status: 403 });
  try {
    const url = new URL(request.url);
    const method = request.method;
    const git = reviewOperation(scope, method, url, undefined) === 'git';
    let json: string | undefined;
    let body: unknown;
    if (request.body && !git) {
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get('content-type') ?? ''
        ) ||
        request.headers.has('content-encoding')
      )
        return deny();
      body = await readBoundedJsonBody(request.body, REVIEW_PUBLICATION_MAX_BYTES);
      json = JSON.stringify(body);
    }
    const operation = reviewOperation(scope, method, url, body);
    if (!operation) return deny();
    const headers = await access.redeem();
    if (!headers) return deny();
    headers.set('User-Agent', 'Kilo-Code-Review');
    headers.set('Accept', 'application/json');
    if (!(await verifyTarget(scope, url, headers, operation, access))) return deny();
    const accept = request.headers.get('Accept');
    if (accept) headers.set('Accept', accept);
    if (git && method === 'POST')
      headers.set('Content-Type', 'application/x-git-upload-pack-request');
    if (git && request.headers.get('Git-Protocol') === 'version=2')
      headers.set('Git-Protocol', 'version=2');
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url.href, {
      method,
      headers,
      body: git ? request.body : json,
      redirect: 'manual',
    });
    if (
      scope.provider === 'bitbucket' &&
      method === 'POST' &&
      response.status === 201 &&
      access.bitbucketAuthor &&
      response.body
    ) {
      const result = await readBoundedJsonBody(response.body, 1024 * 1024);
      const author = z.object({ user: bbAuthor }).safeParse(result);
      if (author.success) {
        // The provider already created the comment. A local recording failure must not trigger a duplicate.
        await access.bitbucketAuthor.record(author.data.user.uuid).catch(() => undefined);
      }
      return Response.json(result, { status: 201 });
    }
    return response;
  } catch {
    return deny();
  }
}
