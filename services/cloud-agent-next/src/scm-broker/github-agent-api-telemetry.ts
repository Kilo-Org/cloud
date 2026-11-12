import { logDiagnostic } from './diagnostics.js';

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

export function githubAgentApiFacts(
  request: Request,
  identity: {
    installationId?: string;
    appType?: string;
    source?: string;
  },
  response: Response
) {
  const url = new URL(request.url);
  if (url.hostname !== 'api.github.com' && url.hostname !== 'uploads.github.com') return null;
  const endpointClass =
    url.hostname === 'uploads.github.com'
      ? 'upload'
      : url.pathname === '/graphql'
        ? 'graphql'
        : request.method === 'GET' || request.method === 'HEAD'
          ? 'rest_read'
          : 'rest_write';
  return {
    event: 'github_agent_api',
    reason: 'agent_request',
    source: 'managed_scm_broker',
    attribution: 'workspace_shared_capability',
    installationId: identity.installationId ?? null,
    appType: identity.appType ?? null,
    authSource: identity.source ?? null,
    endpointClass,
    method: request.method,
    status: response.status,
    rateLimitRemaining: headerNumber(response.headers, 'x-ratelimit-remaining'),
    rateLimitUsed: headerNumber(response.headers, 'x-ratelimit-used'),
    rateLimitReset: headerNumber(response.headers, 'x-ratelimit-reset'),
    rateLimitLimit: headerNumber(response.headers, 'x-ratelimit-limit'),
  };
}

export function logGitHubAgentApiRequest(
  request: Request,
  identity: {
    installationId?: string;
    appType?: string;
    source?: string;
  },
  response: Response
): void {
  const facts = githubAgentApiFacts(request, identity, response);
  if (facts !== null) logDiagnostic('info', facts, 'Managed agent GitHub API request observed');
}
