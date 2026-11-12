import { isGitHubTaskDestination, prepareGitHubTaskRequest } from '../github-task-outbound.js';

/**
 * Forwards a request that carries no managed capability. GitHub task destinations
 * accept only an anonymous read, so a guest credential never reaches them.
 */
export async function forwardUnmanagedScmRequest(request: Request): Promise<Response> {
  if (!isGitHubTaskDestination(new URL(request.url))) return fetch(request);
  const hasGuestAuthorization =
    request.headers.has('Authorization') || request.headers.has('PRIVATE-TOKEN');
  if (!hasGuestAuthorization && ['GET', 'HEAD'].includes(request.method)) {
    const prepared = await prepareGitHubTaskRequest(request);
    if (prepared) return fetch(new Request(prepared.request, { redirect: 'manual' }));
  }
  return new Response('Use the managed GitHub task credential', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="GitHub task"' },
  });
}
