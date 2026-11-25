import { isReviewQuery } from './review-github-query.js';
import { z } from 'zod';
import type { ReviewCapability } from './review-capability.js';

const positive = z.number().int().positive();
const text = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const bodyOnly = z.object({ body: text }).strict();
const marker = '<!-- kilo-review -->';
const ghComment = z
  .object({
    body: text,
    path: text,
    line: positive,
    side: z.literal('RIGHT'),
    start_line: positive.optional(),
    start_side: z.literal('RIGHT').optional(),
  })
  .strict();
const ghReview = z
  .object({
    event: z.literal('COMMENT'),
    commit_id: sha,
    body: z.string().optional(),
    comments: z.array(ghComment).min(1).max(100),
  })
  .strict();
const glPosition = z
  .object({
    base_sha: sha,
    start_sha: sha,
    head_sha: sha,
    position_type: z.literal('text'),
    new_path: text.optional(),
    new_line: positive.optional(),
    old_path: text.optional(),
    old_line: positive.optional(),
  })
  .strict();
const glDiscussion = z.object({ body: text, position: glPosition }).strict();
const bbComment = z
  .object({
    content: z.object({ raw: text }).strict(),
    inline: z.object({ path: text, to: positive }).strict().optional(),
  })
  .strict();

export type ReviewOperation =
  | 'read'
  | 'git'
  | 'inline'
  | 'summary-create'
  | 'summary-edit'
  | 'summary-read';
const read = (method: string) => method === 'GET' || method === 'HEAD';

function reviewReadQuery(url: URL, scope: ReviewCapability): boolean {
  return [...url.searchParams].every(
    ([key, value]) =>
      url.searchParams.getAll(key).length === 1 &&
      ((['page', 'per_page', 'pagelen'].includes(key) && /^\d{1,8}$/.test(value)) ||
        (scope.provider === 'gitlab' &&
          url.pathname.endsWith('/merge_requests/' + scope.number) &&
          ['include_diverged_commits_count', 'include_rebase_in_progress', 'render_html'].includes(
            key
          ) &&
          value === 'true') ||
        (scope.provider === 'gitlab' &&
          url.pathname.endsWith('/merge_requests/' + scope.number + '/discussions') &&
          key === 'sort' &&
          ['asc', 'desc'].includes(value)) ||
        (scope.provider === 'bitbucket' &&
          key === 'from_pullrequest_id' &&
          value === String(scope.number)))
  );
}

export function reviewOperation(
  scope: ReviewCapability,
  method: string,
  url: URL,
  body: unknown
): ReviewOperation | null {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  const path = url.origin + url.pathname;
  const git = scope.gitUrl;
  const gitPath = scope.provider === 'github' ? path.toLowerCase() : path;
  if (
    scope.provider === 'github' &&
    path === 'https://api.github.com/graphql' &&
    method === 'POST' &&
    !url.search &&
    scope.number
  )
    return isReviewQuery(body, git.slice('https://github.com/'.length, -4), scope.number)
      ? 'read'
      : null;
  if (
    method === 'GET' &&
    url.search === '?service=git-upload-pack' &&
    gitPath === git + '/info/refs'
  )
    return 'git';
  if (method === 'POST' && !url.search && gitPath === git + '/git-upload-pack') return 'git';
  if (!scope.number || (read(method) ? !reviewReadQuery(url, scope) : !!url.search)) return null;
  const root = scope.apiRoot;
  let tail = path.startsWith(root + '/') ? path.slice(root.length) : path === root ? '' : null;
  if (
    scope.provider === 'github' &&
    (path.toLowerCase() === root || path.toLowerCase().startsWith(root + '/'))
  )
    tail = path.slice(root.length);
  if (scope.provider === 'gitlab' && scope.projectId) {
    const numeric = root.slice(0, root.lastIndexOf('/') + 1) + scope.projectId;
    if (path.startsWith(numeric + '/') || path === numeric) tail = path.slice(numeric.length);
  }
  if (tail === null) return null;
  if (read(method) && tail === '') return 'read';
  const n = scope.number;
  if (scope.provider === 'github') {
    if (
      read(method) &&
      [
        '/pulls/' + n,
        '/pulls/' + n + '/files',
        '/pulls/' + n + '/reviews',
        '/pulls/' + n + '/comments',
        '/issues/' + n + '/comments',
      ].includes(tail)
    )
      return 'read';
    if (
      method === 'POST' &&
      tail === '/pulls/' + n + '/reviews' &&
      ghReview.safeParse(body).success
    )
      return 'inline';
    const summary = bodyOnly.safeParse(body);
    if (
      method === 'POST' &&
      tail === '/issues/' + n + '/comments' &&
      summary.success &&
      summary.data.body.trimStart().startsWith(marker)
    )
      return 'summary-create';
    if (/^\/issues\/comments\/[1-9]\d*$/.test(tail)) {
      if (read(method)) return 'summary-read';
      if (method === 'PATCH' && summary.success && summary.data.body.trimStart().startsWith(marker))
        return 'summary-edit';
    }
  } else if (scope.provider === 'gitlab') {
    const mr = '/merge_requests/' + n;
    if (
      read(method) &&
      [
        '',
        '/notes',
        '/discussions',
        '/approval_state',
        '/changes',
        '/diffs',
        '/raw_diffs',
        '/versions',
        '/commits',
      ].some(suffix => tail === mr + suffix)
    )
      return 'read';
    if (!tail.startsWith(mr + '/')) return null;
    const route = tail.slice(mr.length);
    if (read(method) && /^\/versions\/[1-9]\d*$/.test(route)) return 'read';
    const parsed =
      route === '/discussions' ? glDiscussion.safeParse(body) : bodyOnly.safeParse(body);
    // GitLab interprets slash commands at the start of a line, including CR line endings.
    if (!parsed.success || /(?:^|[\r\n\u2028\u2029])\s*\//u.test(parsed.data.body)) return null;
    if (method === 'POST' && route === '/discussions') return 'inline';
    if (!parsed.data.body.trimStart().startsWith(marker)) return null;
    if (method === 'POST' && route === '/notes') return 'summary-create';
    if (method === 'PUT' && /^\/notes\/[1-9]\d*$/.test(route)) return 'summary-edit';
  } else {
    const pr = '/pullrequests/' + n;
    if (
      read(method) &&
      (['', '/diff', '/diffstat', '/comments'].some(suffix => tail === pr + suffix) ||
        (tail.startsWith(pr + '/comments/') &&
          /^\d+$/.test(tail.slice((pr + '/comments/').length))) ||
        /^\/(diff|diffstat)\/[a-f0-9.]+$/i.test(tail))
    )
      return 'read';
    const comment = bbComment.safeParse(body);
    if (!comment.success) return null;
    const summary = comment.data.content.raw.trimStart().startsWith('## Code Review Summary');
    if (method === 'POST' && tail === pr + '/comments') {
      if (comment.data.inline) return summary ? null : 'inline';
      return summary ? 'summary-create' : null;
    }
    if (
      method === 'PUT' &&
      !comment.data.inline &&
      summary &&
      tail.startsWith(pr + '/comments/') &&
      /^[1-9]\d*$/.test(tail.slice((pr + '/comments/').length))
    )
      return 'summary-edit';
  }
  return null;
}
