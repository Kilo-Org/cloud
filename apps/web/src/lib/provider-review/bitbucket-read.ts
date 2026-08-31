import 'server-only';

import { z } from 'zod';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import { getMissingBitbucketWorkspaceAccessTokenScopes } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import {
  ReviewActionSchema,
  ReviewCapabilitiesSchema,
  ReviewRevisionSchema,
  REVIEW_WRITE_REQUEST_MAX_BYTES,
  parseReviewCursor,
  reviewPageKey,
  reviewResourceKey,
  type ReviewCapability,
  type ReviewCursor,
  type ReviewFile,
  type ReviewFileContext,
  type ReviewIdentity,
  type ReviewInbox,
  type ReviewInboxItem,
  type ReviewOverview,
  type ReviewPage,
  type ReviewPageScope,
  type ReviewRevision,
  type ReviewThread,
} from '@kilocode/app-shared/provider-review';
import {
  BitbucketInteractiveClientError,
  type BitbucketInteractiveBrokerRequest,
} from '@/lib/integrations/platforms/bitbucket/interactive-client';
import {
  BITBUCKET_MAX_RESPONSE_BYTES,
  assertBitbucketUrl,
} from '../../../../../services/git-token-service/src/bitbucket-safe-transport';
import {
  BitbucketPathSchema,
  BitbucketProviderRepositorySchema,
  BitbucketUserSchema,
  BitbucketUuidSchema,
  assertBitbucketRepository,
  assertBitbucketReviewIdentity,
  bitbucketActor,
  bitbucketRepository,
  parseBitbucket,
  type BitbucketReviewAuthorization,
} from './bitbucket-authorization';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform(value => value.toLowerCase());
const providerSha = z
  .string()
  .regex(/^[a-f0-9]{7,40}$/i)
  .transform(value => value.toLowerCase());
const link = z.object({ href: z.string() });
const participant = z.object({
  user: BitbucketUserSchema,
  role: z.string().min(1),
  state: z.enum(['approved', 'changes_requested']).nullish(),
  approved: z.boolean().optional(),
  participated_on: z.string().nullish(),
});
const summarySchema = z.object({
  type: z.literal('pullrequest'),
  id,
  title: z.string(),
  description: z.string().nullish(),
  summary: z.object({ raw: z.string().nullish() }).nullish(),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  draft: z.boolean().optional(),
  updated_on: z.string(),
  author: BitbucketUserSchema.nullish(),
  links: z.object({ html: link }),
  destination: z.object({
    repository: z.object({
      uuid: BitbucketProviderRepositorySchema.shape.uuid,
      full_name: BitbucketProviderRepositorySchema.shape.full_name,
      workspace: BitbucketProviderRepositorySchema.shape.workspace.optional(),
    }),
  }),
});
const reviewSchema = summarySchema.extend({
  source: z.object({
    repository: BitbucketProviderRepositorySchema.nullable(),
    branch: z.object({ name: z.string().min(1) }).nullable(),
    commit: z.object({ hash: providerSha }),
  }),
  destination: z.object({
    repository: BitbucketProviderRepositorySchema,
    branch: z.object({ name: BitbucketPathSchema }),
    commit: z.object({ hash: providerSha }),
  }),
  participants: z.array(participant),
  task_count: z.number().int().nonnegative().optional(),
});
const entrySchema = z.object({
  path: BitbucketPathSchema,
  commit: z.object({ hash: sha }).optional(),
  attributes: z.array(z.string()).optional(),
  links: z.object({ self: link.optional() }).optional(),
});
const diffstatSchema = z
  .object({
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed']),
    old: entrySchema.nullish(),
    new: entrySchema.nullish(),
    lines_added: z.number().int().nonnegative().nullish(),
    lines_removed: z.number().int().nonnegative().nullish(),
  })
  .refine(value => value.old != null || value.new != null);
const statusSchema = z.object({
  key: z.string().min(1),
  state: z.string(),
  name: z.string().nullish(),
  url: z.string().nullish(),
});
const restrictionSchema = z.object({
  kind: z.string().min(1),
  branch_match_kind: z.enum(['glob', 'branching_model']).default('glob'),
  pattern: z.string().optional(),
  value: z.number().int().nonnegative().optional(),
  users: z.array(z.object({ uuid: BitbucketUuidSchema })).optional(),
  groups: z.array(z.object({ slug: z.string().optional() })).optional(),
});
const commentSchema = z
  .object({
    id,
    created_on: z.string(),
    content: z.object({ raw: z.string() }).nullish(),
    deleted: z.boolean().optional(),
    user: BitbucketUserSchema.nullish(),
    parent: z.object({ id }).nullish(),
    inline: z
      .object({
        path: BitbucketPathSchema,
        from: id.nullish(),
        to: id.nullish(),
        start_from: id.nullish(),
        start_to: id.nullish(),
      })
      .nullish(),
    resolution: z.object({}).nullish(),
    pullrequest: z.object({ id }).optional(),
  })
  .refine(value => value.deleted === true || value.content != null);
const docs = 'https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/';
type PageRequest = BitbucketInteractiveBrokerRequest<
  'pullRequests' | 'diffstat' | 'statuses' | 'comments' | 'commits' | 'restrictions'
>;

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > BITBUCKET_MAX_RESPONSE_BYTES)
    throw new BitbucketInteractiveClientError('response_too_large');
  return value;
}
function scope(
  auth: BitbucketReviewAuthorization,
  surface: ReviewPageScope['surface'],
  queryKey: string,
  identity?: ReviewIdentity,
  revision: ReviewRevision | null = null
): ReviewPageScope {
  return {
    resourceKey: JSON.stringify([
      identity
        ? reviewResourceKey(auth.userId, identity)
        : repositoryResourceKey(auth.userId, auth),
      auth.actor.id,
      auth.credentialKind,
      [...auth.scopes].sort(),
    ]),
    surface,
    queryKey,
    revision,
  };
}
function pagePath(auth: BitbucketReviewAuthorization, request: PageRequest) {
  const base = `/2.0/repositories/${encodeURIComponent(auth.path.workspace)}/${encodeURIComponent(auth.path.repo_slug)}`;
  if (request.operation === 'pullRequests') return `${base}/pullrequests`;
  if (request.operation === 'restrictions') return `${base}/branch-restrictions`;
  if (request.operation === 'diffstat')
    return `${base}/diffstat/${encodeURIComponent(request.params.path.spec)}`;
  return `${base}/pullrequests/${request.params.path.pull_request_id}/${request.operation}`;
}
function pageUrl(value: string, path: string) {
  try {
    // Leave room for the page counter and JSON envelope in the shared 4096-character cursor.
    parseBitbucket(z.string().max(4000), value, 'invalid_pagination');
    return assertBitbucketUrl(value, path).href;
  } catch {
    throw new BitbucketInteractiveClientError('invalid_pagination');
  }
}
async function page<T>(
  auth: BitbucketReviewAuthorization,
  request: PageRequest,
  schema: z.ZodType<T>,
  bound: ReviewPageScope,
  cursor?: ReviewCursor | null
): Promise<ReviewPage<T>> {
  let continuation: { count: number; next: string } | undefined;
  if (cursor) {
    try {
      continuation = z
        .object({ count: id.max(99), next: z.string().min(1).max(4000) })
        .parse(JSON.parse(parseReviewCursor(cursor, bound).token));
    } catch {
      throw new BitbucketInteractiveClientError('invalid_pagination');
    }
    pageUrl(continuation.next, pagePath(auth, request));
  }
  const result = await auth.client.execute({
    ...request,
    ...(continuation ? { next: continuation.next } : {}),
  });
  if (result.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  const data = parseBitbucket(
    z.object({ values: z.array(schema).max(50), next: z.string().optional() }),
    result.data
  );
  if (data.next !== result.next) throw new BitbucketInteractiveClientError('invalid_response');
  const count = (continuation?.count ?? 0) + 1;
  if (result.next && count >= 100) throw new BitbucketInteractiveClientError('page_limit_exceeded');
  const next = result.next ? pageUrl(result.next, pagePath(auth, request)) : null;
  if (next && next === continuation?.next)
    throw new BitbucketInteractiveClientError('invalid_pagination');
  return bounded({
    items: data.values,
    nextCursor: next
      ? { scopeKey: reviewPageKey(bound), token: JSON.stringify({ count, next }) }
      : null,
  });
}
async function collect<T>(
  auth: BitbucketReviewAuthorization,
  request: PageRequest,
  schema: z.ZodType<T>,
  bound: ReviewPageScope
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: ReviewCursor | null = null;
  do {
    const result: ReviewPage<T> = await page(auth, request, schema, bound, cursor);
    items.push(...result.items);
    if (items.length > 5000) throw new BitbucketInteractiveClientError('item_limit_exceeded');
    bounded(items);
    cursor = result.nextCursor;
    if (cursor) {
      const next = parseBitbucket(z.object({ next: z.string() }), JSON.parse(cursor.token)).next;
      if (seen.has(next)) throw new BitbucketInteractiveClientError('invalid_pagination');
      seen.add(next);
    }
  } while (cursor);
  return items;
}
function item(
  auth: BitbucketReviewAuthorization,
  review: z.infer<typeof summarySchema>
): ReviewInboxItem {
  const destination = review.destination.repository;
  if (
    destination.uuid !== auth.repository.repositoryId ||
    destination.full_name !== auth.repository.fullName
  )
    throw new BitbucketInteractiveClientError('repository_mismatch');
  if (destination.workspace && destination.workspace.uuid !== auth.repository.workspaceUuid)
    throw new BitbucketInteractiveClientError('workspace_mismatch');
  const number = String(review.id);
  const canonicalUrl = `https://bitbucket.org/${auth.repository.fullName}/pull-requests/${number}`;
  if (review.links.html.href !== canonicalUrl)
    throw new BitbucketInteractiveClientError('repository_mismatch');
  return {
    identity: {
      repository: auth.repository,
      authorization: auth.authorization,
      reviewId: number,
      number,
      canonicalUrl,
    },
    title: review.title,
    author: review.author ? bitbucketActor(review.author) : null,
    state: review.state === 'OPEN' ? 'open' : review.state === 'MERGED' ? 'merged' : 'closed',
    draft: review.draft ?? false,
    updatedAt: review.updated_on,
  };
}
export async function listBitbucketInbox(
  auth: BitbucketReviewAuthorization,
  input: {
    cursor?: ReviewCursor | null;
    state?: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  } = {}
): Promise<ReviewInbox> {
  const state = parseBitbucket(
    z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
    input.state ?? 'OPEN',
    'invalid_request'
  );
  const result = await page(
    auth,
    { operation: 'pullRequests', params: { path: auth.path, query: { state } } },
    summarySchema,
    scope(auth, 'inbox', state),
    input.cursor
  );
  return bounded({
    ...result,
    items: result.items.map(review => item(auth, review)),
    scope: { kind: 'repository', actor: auth.actor, repository: auth.repository },
  });
}
async function resolveCommit(auth: BitbucketReviewAuthorization, hash: string) {
  const result = await auth.client.execute({
    operation: 'commit',
    params: { path: { ...auth.path, commit: hash } },
  });
  if (result.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  const commit = parseBitbucket(z.object({ hash: sha }), result.data);
  if (!commit.hash.startsWith(hash)) throw new BitbucketInteractiveClientError('invalid_response');
  return commit.hash;
}
async function load(auth: BitbucketReviewAuthorization, number: string) {
  const numeric = parseBitbucket(
    id,
    Number(parseBitbucket(z.string().regex(/^[1-9]\d*$/), number, 'invalid_request')),
    'invalid_request'
  );
  const path = { ...auth.path, pull_request_id: numeric };
  const response = await auth.client.execute({
    operation: 'pullRequest',
    params: {
      path,
      query: { fields: '+source.repository.workspace,+destination.repository.workspace' },
    },
  });
  if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  const review = parseBitbucket(reviewSchema, response.data);
  if (review.id !== numeric) throw new BitbucketInteractiveClientError('repository_mismatch');
  assertBitbucketRepository(auth.repository, review.destination.repository);
  const summary = item(auth, review);
  let headSha = review.source.commit.hash;
  let targetHeadSha = review.destination.commit.hash;
  if (headSha.length !== 40) {
    const commits = await collect(
      auth,
      { operation: 'commits', params: { path } },
      z.object({ hash: sha }),
      scope(auth, 'files', 'resolve-head', summary.identity)
    );
    const candidates = commits.filter(commit => commit.hash.startsWith(headSha));
    if (candidates.length > 1) throw new BitbucketInteractiveClientError('temporarily_unavailable');
    // Deleted source branches can leave this list empty. Resolve only through the authorized repository.
    headSha = candidates[0]?.hash ?? (await resolveCommit(auth, headSha));
  }
  if (targetHeadSha.length !== 40) targetHeadSha = await resolveCommit(auth, targetHeadSha);
  const revision: ReviewRevision = { headSha, targetHeadSha, baseSha: null, startSha: null };
  return {
    auth,
    review,
    summary,
    identity: summary.identity,
    path,
    revision,
    source: review.source.repository ? bitbucketRepository(review.source.repository) : null,
  };
}
type Loaded = Awaited<ReturnType<typeof load>>;
function heads(selected: ReviewRevision, actual: ReviewRevision) {
  const value = parseBitbucket(ReviewRevisionSchema, selected, 'invalid_request');
  if (
    value.headSha !== actual.headSha ||
    value.targetHeadSha !== actual.targetHeadSha ||
    value.startSha !== null
  )
    throw new BitbucketInteractiveClientError('conflict');
}
async function exact(auth: BitbucketReviewAuthorization, identity: ReviewIdentity) {
  assertBitbucketReviewIdentity(auth, identity);
  return load(auth, identity.number);
}
async function unchanged(loaded: Loaded) {
  const current = await exact(loaded.auth, loaded.identity);
  heads(loaded.revision, current.revision);
  if (
    loaded.source?.repositoryId !== current.source?.repositoryId ||
    loaded.source?.workspaceUuid !== current.source?.workspaceUuid ||
    loaded.source?.fullName !== current.source?.fullName ||
    loaded.review.source.branch?.name !== current.review.source.branch?.name ||
    loaded.review.destination.branch.name !== current.review.destination.branch.name
  )
    throw new BitbucketInteractiveClientError('conflict');
}
function diffRequest(loaded: Loaded, path?: string): BitbucketInteractiveBrokerRequest<'diffstat'> {
  return {
    operation: 'diffstat',
    // Bitbucket's order is the reverse of git diff. topic=true compares the source with its merge base.
    params: {
      path: {
        ...loaded.auth.path,
        spec: `${loaded.revision.headSha}..${loaded.revision.targetHeadSha}`,
      },
      query: { topic: true, ...(path ? { path } : {}) },
    },
  };
}
function entryCommit(
  loaded: Loaded,
  entry: z.infer<typeof entrySchema> | null | undefined
): string | null {
  if (!entry) return null;
  let commit = entry.commit?.hash ?? null;
  const href = entry.links?.self?.href;
  if (href) {
    let url: URL;
    try {
      url = new URL(href);
      assertBitbucketUrl(href, url.pathname);
      const parts = url.pathname.split('/').map(decodeURIComponent);
      const repository = [loaded.auth.repository, loaded.source].find(
        repository =>
          repository &&
          ((parts[3] === repository.fullName.split('/')[0] &&
            parts[4] === repository.fullName.split('/')[1]) ||
            (parts[3] === `{${repository.workspaceUuid}}` &&
              parts[4] === `{${repository.repositoryId}}`))
      );
      if (
        !repository ||
        parts[2] !== 'repositories' ||
        parts[5] !== 'src' ||
        parts.slice(7).join('/') !== entry.path ||
        url.search
      )
        throw new Error('identity');
      const linked = parseBitbucket(sha, parts[6]);
      if (commit && commit !== linked) throw new Error('revision');
      commit = linked;
    } catch {
      throw new BitbucketInteractiveClientError('invalid_response');
    }
  }
  return commit;
}
function fileUrl(loaded: Loaded, side: 'old' | 'new', path: string, commit: string | null) {
  const repository = side === 'old' ? loaded.auth.repository : loaded.source;
  return repository && commit
    ? `https://bitbucket.org/${repository.fullName}/src/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`
    : `${loaded.identity.canonicalUrl}/diff`;
}
function fileFromStat(loaded: Loaded, stat: z.infer<typeof diffstatSchema>): ReviewFile {
  const oldPath = stat.old?.path ?? null;
  const newPath = stat.new?.path ?? null;
  const newCommit = entryCommit(loaded, stat.new);
  if (newCommit && newCommit !== loaded.revision.headSha)
    throw new BitbucketInteractiveClientError('conflict');
  const baseSha = entryCommit(loaded, stat.old);
  const binary = [...(stat.old?.attributes ?? []), ...(stat.new?.attributes ?? [])].includes(
    'binary'
  );
  return {
    id: JSON.stringify([oldPath, newPath]),
    oldPath,
    newPath,
    // The PR omits its merge base. Preserve the immutable old entry revision when diffstat supplies it.
    revision: { ...loaded.revision, baseSha },
    status: stat.status === 'removed' ? 'deleted' : stat.status,
    additions: stat.lines_added ?? null,
    deletions: stat.lines_removed ?? null,
    patch: null,
    content: binary ? 'binary' : 'unavailable',
    canonicalUrl: fileUrl(
      loaded,
      newPath ? 'new' : 'old',
      newPath ?? oldPath ?? '',
      newPath ? loaded.revision.headSha : baseSha
    ),
  };
}
async function withPatch(loaded: Loaded, file: ReviewFile): Promise<ReviewFile> {
  if (file.content === 'binary') return file;
  const request = diffRequest(loaded, file.newPath ?? file.oldPath ?? undefined);
  try {
    const response = await loaded.auth.client.execute({ ...request, operation: 'diff' });
    if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
    const patch = parseBitbucket(z.string(), response.data);
    if (/(^|\n)(Binary files |GIT binary patch)/.test(patch)) return { ...file, content: 'binary' };
    let additions = 0,
      deletions = 0,
      oldRemaining = 0,
      newRemaining = 0,
      hunk = false;
    // Diffstat can omit counts and never counts unchanged context lines.
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith('@@') || line.startsWith('diff --git ')) {
        if (oldRemaining !== 0 || newRemaining !== 0) return { ...file, content: 'truncated' };
        hunk = line.startsWith('@@');
        if (!hunk) continue;
        const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
        if (!header) return file;
        oldRemaining = Number(header[1] ?? 1);
        newRemaining = Number(header[2] ?? 1);
      } else if (hunk) {
        if (line.startsWith('+')) {
          additions++;
          newRemaining--;
        } else if (line.startsWith('-')) {
          deletions++;
          oldRemaining--;
        } else if (line.startsWith(' ')) {
          oldRemaining--;
          newRemaining--;
        } else if (line !== '' && line !== '\\ No newline at end of file') return file;
        if (oldRemaining < 0 || newRemaining < 0) return { ...file, content: 'truncated' };
      }
    }
    if (
      oldRemaining !== 0 ||
      newRemaining !== 0 ||
      (file.additions !== null && additions !== file.additions) ||
      (file.deletions !== null && deletions !== file.deletions)
    )
      return { ...file, content: 'truncated' };
    if (!patch && !(file.additions === 0 && file.deletions === 0)) return file;
    return { ...file, patch, content: 'available' };
  } catch (error) {
    if (error instanceof BitbucketInteractiveClientError && error.code === 'response_too_large')
      return { ...file, content: 'truncated' };
    if (
      error instanceof BitbucketInteractiveClientError &&
      ['not_found', 'invalid_response'].includes(error.code)
    )
      return file;
    throw error;
  }
}
export async function listBitbucketFiles(
  auth: BitbucketReviewAuthorization,
  identity: ReviewIdentity,
  selected: ReviewRevision,
  cursor?: ReviewCursor | null
): Promise<ReviewPage<ReviewFile>> {
  const loaded = await exact(auth, identity);
  heads(selected, loaded.revision);
  const result = await page(
    auth,
    diffRequest(loaded),
    diffstatSchema,
    scope(
      auth,
      'files',
      JSON.stringify([
        'topic',
        loaded.source,
        loaded.review.source.branch,
        loaded.review.destination.branch,
      ]),
      identity,
      selected
    ),
    cursor
  );
  const items: ReviewFile[] = [];
  for (const stat of result.items) {
    items.push(await withPatch(loaded, fileFromStat(loaded, stat)));
    bounded(items);
  }
  await unchanged(loaded);
  return bounded({ ...result, items });
}
export async function getBitbucketFileContext(
  auth: BitbucketReviewAuthorization,
  identity: ReviewIdentity,
  input: {
    file: Pick<ReviewFile, 'oldPath' | 'newPath' | 'revision'>;
    side: 'old' | 'new';
    startLine: number;
    lineCount: number;
  }
): Promise<ReviewFileContext> {
  parseBitbucket(
    z.object({
      side: z.enum(['old', 'new']),
      startLine: id,
      lineCount: id.max(500),
      file: z.object({
        oldPath: BitbucketPathSchema.nullable(),
        newPath: BitbucketPathSchema.nullable(),
        revision: ReviewRevisionSchema,
      }),
    }),
    input,
    'invalid_request'
  );
  const loaded = await exact(auth, identity);
  heads(input.file.revision, loaded.revision);
  const path = input.side === 'old' ? input.file.oldPath : input.file.newPath;
  if (!path) throw new BitbucketInteractiveClientError('invalid_request');
  const stats = await collect(
    auth,
    diffRequest(loaded, input.file.newPath ?? input.file.oldPath ?? undefined),
    diffstatSchema,
    scope(auth, 'context', path, identity, input.file.revision)
  );
  const stat = stats.find(
    stat =>
      (stat.old?.path ?? null) === input.file.oldPath &&
      (stat.new?.path ?? null) === input.file.newPath
  );
  if (!stat) throw new BitbucketInteractiveClientError('conflict');
  const file = fileFromStat(loaded, stat);
  if (file.revision.baseSha !== input.file.revision.baseSha)
    throw new BitbucketInteractiveClientError('conflict');
  const commit = input.side === 'old' ? file.revision.baseSha : file.revision.headSha;
  let result: ReviewFileContext = {
    revision: file.revision,
    path,
    side: input.side,
    startLine: input.startLine,
    lines: [],
    totalLines: null,
    content: 'unavailable',
    canonicalUrl: fileUrl(loaded, input.side, path, commit),
  };
  if (commit && (input.side === 'old' || loaded.source)) {
    const source =
      input.side === 'new' && loaded.source
        ? {
            pullRequestId: loaded.path.pull_request_id,
            workspaceUuid: loaded.source.workspaceUuid,
            repositoryUuid: loaded.source.repositoryId,
          }
        : undefined;
    const params = { path: { ...auth.path, commit, path } };
    try {
      const response = await auth.client.execute({
        operation: 'fileMetadata',
        params,
        ...(source ? { source } : {}),
      });
      if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
      const metadata = parseBitbucket(
        z.object({
          type: z.enum(['commit_file', 'commit_directory']),
          path: BitbucketPathSchema,
          commit: z.object({ hash: providerSha }).optional(),
          size: z.number().int().nonnegative().optional(),
          attributes: z.array(z.string()).optional(),
        }),
        response.data
      );
      if (metadata.path !== path || (metadata.commit && !commit.startsWith(metadata.commit.hash)))
        throw new BitbucketInteractiveClientError('conflict');
      if (metadata.attributes?.includes('binary')) result.content = 'binary';
      else if (metadata.size !== undefined && metadata.size > BITBUCKET_MAX_RESPONSE_BYTES)
        result.content = 'truncated';
      else if (
        metadata.type === 'commit_file' &&
        !metadata.attributes?.some(attribute => ['link', 'subrepository'].includes(attribute))
      ) {
        const raw = await auth.client.execute({
          operation: 'file',
          params,
          ...(source ? { source } : {}),
        });
        if (raw.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
        const text = parseBitbucket(z.string(), raw.data);
        if (text.includes('\0')) result.content = 'binary';
        else if (metadata.size !== undefined && Buffer.byteLength(text, 'utf8') !== metadata.size)
          result.content = 'truncated';
        else {
          const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
          result = bounded({
            ...result,
            content: 'available',
            totalLines: lines.length,
            lines: lines.slice(input.startLine - 1, input.startLine - 1 + input.lineCount),
          });
        }
      }
    } catch (error) {
      if (!(error instanceof BitbucketInteractiveClientError)) throw error;
      if (error.code === 'response_too_large') result.content = 'truncated';
      else if (!['not_found', 'insufficient_permissions', 'invalid_response'].includes(error.code))
        throw error;
    }
  }
  await unchanged(loaded);
  return result;
}
async function checks(loaded: Loaded): Promise<ReviewOverview['checks']> {
  try {
    const values = await collect(
      loaded.auth,
      { operation: 'statuses', params: { path: loaded.path } },
      statusSchema,
      scope(loaded.auth, 'checks', 'source', loaded.identity, loaded.revision)
    );
    if (!values.length) return { status: 'none', checks: [] };
    return {
      status: 'reported',
      checks: values.map(value => ({
        id: value.key,
        name: value.name || value.key,
        state:
          value.state === 'SUCCESSFUL'
            ? 'passed'
            : value.state === 'FAILED'
              ? 'failed'
              : value.state === 'INPROGRESS'
                ? 'running'
                : value.state === 'STOPPED'
                  ? 'cancelled'
                  : 'unknown',
        required: null,
        detailsUrl:
          value.url && z.url({ protocol: /^https$/ }).safeParse(value.url).success
            ? value.url
            : null,
      })),
    };
  } catch (error) {
    if (
      error instanceof BitbucketInteractiveClientError &&
      ['insufficient_permissions', 'not_found'].includes(error.code)
    )
      return { status: 'unavailable', explanation: error.code };
    throw error;
  }
}
export async function getBitbucketChecks(
  auth: BitbucketReviewAuthorization,
  identity: ReviewIdentity,
  selected?: ReviewRevision
): Promise<ReviewOverview['checks']> {
  const loaded = await exact(auth, identity);
  if (selected) heads(selected, loaded.revision);
  const result = await checks(loaded);
  await unchanged(loaded);
  return bounded(result);
}
function capabilitySet(loaded: Loaded) {
  const { auth, review } = loaded;
  const own = review.participants?.find(value => value.user.uuid === auth.actor.id);
  // Honor implied pullrequest permission without relaxing action-specific write-grant checks.
  const hasPullRequestScope = !getMissingBitbucketWorkspaceAccessTokenScopes(auth.scopes).includes(
    'pullrequest'
  );
  return ReviewCapabilitiesSchema.parse(
    Object.fromEntries(
      ReviewActionSchema.options.map(action => {
        const grant = [
          'approve',
          'unapprove',
          'requestChanges',
          'removeChangeRequest',
          'submitReview',
          'merge',
        ].includes(action)
          ? 'pullrequest:write'
          : action === 'deleteBranch'
            ? 'repository:write'
            : 'pullrequest';
        const allowed =
          action === 'read' ||
          (grant === 'pullrequest' ? hasPullRequestScope : auth.scopes.includes(grant));
        const value: ReviewCapability = {
          support: 'supported',
          version: 'available',
          license: 'available',
          permission: allowed ? 'allowed' : 'forbidden',
          restrictions: [],
          explanation: allowed ? '' : `missing_scope:${grant}`,
          evidenceUrl: docs,
          recovery: allowed
            ? 'none'
            : auth.credentialKind === 'bitbucketWorkspaceToken'
              ? 'replaceToken'
              : 'reconnect',
          expectedHeadProtection: 'none',
        };
        if (
          [
            'approve',
            'unapprove',
            'requestChanges',
            'removeChangeRequest',
            'submitReview',
            'merge',
          ].includes(action) &&
          review.state !== 'OPEN'
        )
          value.restrictions.push('review_closed');
        if (['approve', 'requestChanges'].includes(action) && review.author?.uuid === auth.actor.id)
          value.restrictions.push('review_author');
        if (action === 'unapprove' || action === 'removeChangeRequest') {
          // Workspace metadata does not identify the app user's participant UUID.
          // It cannot prove that this credential has no approval or change request.
          if (!BitbucketUuidSchema.safeParse(auth.actor.id).success) {
            if (allowed) value.explanation = 'participant_actor_unknown';
          } else if (action === 'unapprove' && !(own?.state === 'approved' || own?.approved)) {
            value.restrictions.push('not_approved');
          } else if (action === 'removeChangeRequest' && own?.state !== 'changes_requested') {
            value.restrictions.push('changes_not_requested');
          }
        }
        if (action === 'submitReview' && allowed)
          value.explanation = 'separate_effects_without_atomic_expected_head';
        if (action === 'merge' && review.draft) value.restrictions.push('draft');
        if (action === 'merge' && allowed && auth.credentialKind === 'bitbucketOAuth') {
          value.permission = 'unknown';
          value.explanation = 'repository_merge_permission_unknown';
          value.recovery = 'openProvider';
        }
        if (
          action === 'deleteBranch' &&
          (loaded.source?.repositoryId !== auth.repository.repositoryId ||
            loaded.source?.workspaceUuid !== auth.repository.workspaceUuid)
        )
          value.restrictions.push('fork_source_requires_separate_authorization');
        if (action === 'deleteBranch' && auth.repository.defaultBranch === null) {
          value.restrictions.push('default_branch_unknown');
          if (allowed) {
            value.explanation = 'default_branch_unknown';
            value.recovery = 'refresh';
          }
        }
        if (
          action === 'deleteBranch' &&
          (!review.source.branch ||
            review.source.branch.name === auth.repository.defaultBranch ||
            review.source.branch.name === review.destination.branch.name)
        )
          value.restrictions.push('source_branch_not_deletable');
        const unsupported =
          action === 'enableAutoMerge' || action === 'disableAutoMerge'
            ? ['BCLOUD-22062', 'auto_merge_scheduling_api_unavailable']
            : action === 'updateBranch'
              ? ['BCLOUD-20489', 'branch_sync_api_unavailable']
              : action === 'addReaction' || action === 'removeReaction'
                ? ['BCLOUD-21346', 'reactions_api_unavailable']
                : null;
        if (unsupported) {
          value.support = 'unsupported';
          value.explanation = unsupported[1];
          value.evidenceUrl = `https://jira.atlassian.com/browse/${unsupported[0]}`;
          value.recovery = 'openProvider';
        }
        return [action, value];
      })
    )
  );
}
async function branchPolicy(
  loaded: Loaded,
  reported: ReviewOverview['checks'],
  capability: ReviewCapability,
  deleteCapability: ReviewCapability
) {
  const { auth, review } = loaded;
  // Destination restrictions cannot establish permission to delete a fork source.
  const sourceBranch =
    loaded.source?.repositoryId === auth.repository.repositoryId &&
    loaded.source?.workspaceUuid === auth.repository.workspaceUuid
      ? review.source.branch?.name
      : undefined;
  const deletionRestrictions: string[] = [];
  let methods: ReviewOverview['merge']['methods'] = [];
  try {
    const response = await auth.client.execute({
      operation: 'branch',
      params: { path: { ...auth.path, name: review.destination.branch.name } },
    });
    if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
    const branch = parseBitbucket(
      z.object({ name: z.string(), merge_strategies: z.array(z.string().min(1)).optional() }),
      response.data
    );
    if (branch.name !== review.destination.branch.name)
      throw new BitbucketInteractiveClientError('repository_mismatch');
    methods = (branch.merge_strategies ?? []).map(id => ({ id, label: id }));
  } catch (error) {
    if (
      !(error instanceof BitbucketInteractiveClientError) ||
      !['not_found', 'insufficient_permissions'].includes(error.code)
    )
      throw error;
  }
  if (!methods.length) capability.restrictions.push('merge_strategies_unavailable');
  try {
    const rules = await collect(
      auth,
      { operation: 'restrictions', params: { path: auth.path } },
      restrictionSchema,
      scope(auth, 'checks', 'merge-restrictions', loaded.identity, loaded.revision)
    );
    const matching = rules.filter(rule => {
      // Only push and restrict_merges rules permit user/group exceptions, never delete rules.
      const restrictsSource =
        rule.kind === 'delete' ||
        (rule.kind === 'push' && !rule.users?.some(user => user.uuid === auth.actor.id));
      if (rule.branch_match_kind === 'branching_model') {
        if (sourceBranch && restrictsSource)
          deletionRestrictions.push('branching_model_restrictions_unknown');
        if (
          rule.kind === 'restrict_merges' ||
          rule.kind === 'enforce_merge_checks' ||
          rule.kind.startsWith('require_')
        )
          capability.restrictions.push('branching_model_restrictions_unknown');
        return false;
      }
      if (rule.pattern === undefined) throw new BitbucketInteractiveClientError('invalid_response');
      // Bitbucket glob restrictions recognize '*' as the wildcard, including branch separators.
      const pattern = rule.pattern
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const matcher = new RegExp(`^${pattern}$`);
      if (sourceBranch && restrictsSource && matcher.test(sourceBranch))
        deletionRestrictions.push(
          rule.kind === 'delete'
            ? 'source_branch_protected'
            : rule.groups?.length
              ? 'delete_group_membership_unknown'
              : 'actor_delete_restricted'
        );
      return matcher.test(review.destination.branch.name);
    });
    const enforced = matching.some(rule => rule.kind === 'enforce_merge_checks');
    const policies = matching.filter(rule => rule.kind.startsWith('require_'));
    if (policies.length)
      capability.explanation = [
        capability.explanation,
        enforced ? 'enforced_merge_checks' : 'advisory_merge_checks',
        ...policies.map(rule => `${rule.kind}:${rule.value ?? ''}`),
      ]
        .filter(Boolean)
        .join(';');
    for (const rule of matching) {
      if (rule.kind === 'restrict_merges' && !rule.users?.some(user => user.uuid === auth.actor.id))
        capability.restrictions.push(
          rule.groups?.length ? 'merge_group_membership_unknown' : 'actor_merge_restricted'
        );
      if (!enforced || !rule.kind.startsWith('require_')) continue;
      if (
        rule.kind === 'require_approvals_to_merge' &&
        rule.value !== undefined &&
        review.participants
      ) {
        if (
          review.participants.filter(value => value.state === 'approved' || value.approved).length <
          rule.value
        )
          capability.restrictions.push('approvals_required');
      } else if (rule.kind === 'require_no_changes_requested') {
        if (review.participants.some(value => value.state === 'changes_requested'))
          capability.restrictions.push('changes_requested');
      } else if (rule.kind === 'require_tasks_to_be_completed' && review.task_count !== undefined) {
        if (review.task_count > 0) capability.restrictions.push('open_tasks');
      } else if (rule.kind === 'require_passing_builds_to_merge' && rule.value !== undefined) {
        if (
          reported.status !== 'reported' ||
          reported.checks.filter(value => value.state === 'passed').length < rule.value ||
          reported.checks.some(value => value.state !== 'passed')
        )
          capability.restrictions.push('passing_builds_required');
      } else capability.restrictions.push(`${rule.kind}:status_unknown`);
    }
  } catch (error) {
    if (
      !(error instanceof BitbucketInteractiveClientError) ||
      !['not_found', 'insufficient_permissions'].includes(error.code)
    )
      throw error;
    capability.restrictions.push('merge_restrictions_unavailable');
    if (sourceBranch) deletionRestrictions.push('delete_restrictions_unavailable');
  }
  if (deletionRestrictions.length) {
    deleteCapability.restrictions.push(...deletionRestrictions);
    deleteCapability.evidenceUrl =
      'https://developer.atlassian.com/cloud/bitbucket/rest/api-group-branch-restrictions/';
    if (deleteCapability.permission === 'allowed') {
      deleteCapability.explanation = [deleteCapability.explanation, ...deletionRestrictions]
        .filter(Boolean)
        .join(';');
      deleteCapability.recovery = 'openProvider';
    }
  }
  return methods;
}
export async function getBitbucketReview(
  auth: BitbucketReviewAuthorization,
  number: string
): Promise<ReviewOverview> {
  const loaded = await load(auth, number);
  const stats = await collect(
    auth,
    diffRequest(loaded),
    diffstatSchema,
    scope(auth, 'files', 'counts', loaded.identity, loaded.revision)
  );
  const files = stats.map(stat => fileFromStat(loaded, stat));
  const commits = await collect(
    auth,
    { operation: 'commits', params: { path: loaded.path } },
    z.object({ hash: sha }),
    scope(auth, 'files', 'commits', loaded.identity, loaded.revision)
  );
  const reported = await checks(loaded);
  const capabilities = capabilitySet(loaded);
  const methods = await branchPolicy(
    loaded,
    reported,
    capabilities.merge,
    capabilities.deleteBranch
  );
  await unchanged(loaded);
  const { identity, title, author, state, draft } = loaded.summary;
  const total = (field: 'additions' | 'deletions') =>
    files.reduce<number | null>(
      (sum, file) => (sum === null || file[field] === null ? null : sum + file[field]),
      0
    );
  return bounded({
    identity,
    title,
    author,
    state,
    draft,
    bodyMarkdown: loaded.review.description ?? loaded.review.summary?.raw ?? null,
    revision: loaded.revision,
    source: { repository: loaded.source, branch: loaded.review.source.branch?.name ?? null },
    target: { repository: auth.repository, branch: loaded.review.destination.branch.name },
    authorization: {
      actor: auth.actor,
      credentialKind: auth.credentialKind,
      capabilities,
      writeLimits: { requestMaxBytes: REVIEW_WRITE_REQUEST_MAX_BYTES, bodyMaxBytes: null },
    },
    providerState: {
      provider: 'bitbucket',
      expectedHeadProtection: 'none',
      participants: (loaded.review.participants ?? []).map(value => ({
        actor: bitbucketActor(value.user),
        role: value.role,
        state: value.state ?? (value.approved ? 'approved' : null),
        participatedOn: value.participated_on ?? null,
      })),
    },
    checks: reported,
    counts: {
      commits: commits.length,
      files: files.length,
      additions: total('additions'),
      deletions: total('deletions'),
    },
    merge: { methods, squash: null, autoMerge: null, task: null },
  });
}
export async function listBitbucketDiscussions(
  auth: BitbucketReviewAuthorization,
  identity: ReviewIdentity,
  cursor?: ReviewCursor | null
): Promise<ReviewPage<ReviewThread>> {
  const loaded = await exact(auth, identity);
  const bound = scope(
    auth,
    'threads',
    JSON.stringify([
      'complete-threads',
      loaded.source,
      loaded.review.source.branch,
      loaded.review.destination.branch,
    ]),
    identity,
    loaded.revision
  );
  let offset = 0;
  if (cursor) {
    try {
      offset = z
        .number()
        .int()
        .positive()
        .max(5000)
        .parse(Number(parseReviewCursor(cursor, bound).token));
    } catch {
      throw new BitbucketInteractiveClientError('invalid_pagination');
    }
  }
  // Bitbucket paginates flat comments, not threads. Complete the bounded set before grouping replies.
  const comments = await collect(
    auth,
    { operation: 'comments', params: { path: loaded.path } },
    commentSchema,
    bound
  );
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  if (byId.size !== comments.length) throw new BitbucketInteractiveClientError('invalid_response');
  const grouped = new Map<number, typeof comments>();
  for (const comment of comments) {
    if (comment.pullrequest && comment.pullrequest.id !== loaded.path.pull_request_id)
      throw new BitbucketInteractiveClientError('repository_mismatch');
    let root = comment;
    const visited = new Set<number>();
    while (root.parent) {
      if (visited.has(root.id)) throw new BitbucketInteractiveClientError('invalid_response');
      visited.add(root.id);
      const parent = byId.get(root.parent.id);
      if (!parent) throw new BitbucketInteractiveClientError('invalid_response');
      root = parent;
    }
    const thread = grouped.get(root.id) ?? [];
    thread.push(comment);
    grouped.set(root.id, thread);
  }
  const capabilities = capabilitySet(loaded);
  const threads: ReviewThread[] = [...grouped].map(([rootId, replies]) => {
    const root = byId.get(rootId);
    if (!root) throw new BitbucketInteractiveClientError('invalid_response');
    const url = `${identity.canonicalUrl}/_/diff#comment-${rootId}`;
    const available = root.deleted
      ? { ...capabilities.resolveThread, restrictions: ['comment_deleted'] }
      : capabilities.resolveThread;
    return {
      id: String(rootId),
      reference: { provider: 'bitbucket', kind: 'thread', id: String(rootId), url },
      subjectType: root.inline
        ? root.inline.from || root.inline.to
          ? 'line'
          : 'file'
        : 'conversation',
      // PR comments carry no immutable revision. A current PR snapshot cannot prove their original position.
      file: null,
      position: null,
      diffHunk: null,
      outdated: null,
      resolved: root.resolution != null,
      comments: {
        items: [root, ...replies.filter(comment => comment.id !== rootId)].map(comment => ({
          id: String(comment.id),
          reference: {
            provider: 'bitbucket',
            kind: 'comment',
            id: String(comment.id),
            url: `${identity.canonicalUrl}/_/diff#comment-${comment.id}`,
          },
          author: comment.deleted || !comment.user ? null : bitbucketActor(comment.user),
          bodyMarkdown: comment.deleted ? '' : (comment.content?.raw ?? ''),
          createdAt: comment.created_on,
          reactions: [],
        })),
        nextCursor: null,
      },
      capabilities: {
        resolveThread: available,
        reopenThread: available,
        addReaction: capabilities.addReaction,
        removeReaction: capabilities.removeReaction,
      },
    };
  });
  if (offset > threads.length || offset % 25 !== 0)
    throw new BitbucketInteractiveClientError('invalid_pagination');
  await unchanged(loaded);
  return bounded({
    items: threads.slice(offset, offset + 25),
    nextCursor:
      offset + 25 < threads.length
        ? { scopeKey: reviewPageKey(bound), token: String(offset + 25) }
        : null,
  });
}
