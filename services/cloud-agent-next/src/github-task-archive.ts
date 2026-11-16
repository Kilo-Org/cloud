import {
  getGitHubTaskArchive,
  githubTaskArchiveRedirect,
} from '@kilocode/worker-utils/github-task-archive';

function archiveResponse(response: Response): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of [
    'content-type',
    'content-length',
    'content-disposition',
    'etag',
    'last-modified',
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Call only after the broker authorizes this exact repository read. */
export async function forwardGitHubTaskArchive(
  request: Request,
  authorization: string | null
): Promise<Response> {
  const archive = getGitHubTaskArchive(new URL(request.url));
  if (!archive || !['GET', 'HEAD'].includes(request.method))
    throw new Error('Invalid GitHub archive request');
  const signal = AbortSignal.timeout(120_000);
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  if (authorization !== null) headers.set('Authorization', authorization);
  headers.set('Accept-Encoding', 'identity');
  const response = await fetch(new Request(request, { headers, signal, redirect: 'manual' }));
  if (response.status === 200) return archiveResponse(response);
  await response.body?.cancel();
  if (response.status !== 302) {
    return new Response('GitHub archive unavailable', {
      status: response.status >= 400 && response.status < 600 ? response.status : 502,
    });
  }
  const location = response.headers.get('location');
  const target = location && githubTaskArchiveRedirect(location, archive);
  if (!target) throw new Error('Invalid GitHub archive redirect');
  // Only GitHub's short-lived download URL reaches codeload. No backing token or guest headers do.
  const download = await fetch(target, {
    method: request.method,
    headers: { 'User-Agent': 'Kilo-Cloud-Agent', 'Accept-Encoding': 'identity' },
    signal,
    redirect: 'manual',
  });
  if (download.status !== 200) {
    await download.body?.cancel();
    throw new Error('GitHub archive download unavailable');
  }
  return archiveResponse(download);
}
