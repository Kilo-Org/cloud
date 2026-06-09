import { safeRepositoryUrlSchema } from '@kilocode/session-ingest-contracts';
import type {
  ListCloudAgentRootSessionsByGitUrlParams,
  ListCloudAgentRootSessionsParams,
} from '../../../session-ingest-binding.js';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { duplicateQueryParametersResponse, facadeError } from '../../http-contract.js';
import { projectPublicListedSession } from '../../public-sdk-projection.js';
import { hasDuplicateQueryParameters } from '../../../shared/http-query.js';

const SUPPORTED_QUERY_PARAMS = new Set(['limit', 'start', 'gitUrl']);
const MAX_TIMESTAMP_MILLISECONDS = 8_640_000_000_000_000;

function parseSessionListQuery(
  url: URL
):
  | (Omit<ListCloudAgentRootSessionsByGitUrlParams, 'kiloUserId' | 'gitUrl'> & { gitUrl?: string })
  | Response {
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_QUERY_PARAMS.has(key)) {
      return facadeError(
        400,
        'KILO_SESSION_LIST_SELECTOR_UNSUPPORTED',
        `Session list query parameter is not supported: ${key}`
      );
    }
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }

  const params: Omit<ListCloudAgentRootSessionsParams, 'kiloUserId'> & { gitUrl?: string } = {};
  const gitUrlParam = url.searchParams.get('gitUrl');
  if (gitUrlParam !== null) {
    const gitUrl = safeRepositoryUrlSchema.safeParse(gitUrlParam);
    if (!gitUrl.success || gitUrl.data !== gitUrlParam) {
      return facadeError(400, 'KILO_QUERY_INVALID', 'Session list gitUrl must be a safe HTTPS URL');
    }
    params.gitUrl = gitUrl.data;
  }
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session list limit must be an integer from 1 to 100'
      );
    }
    params.limit = limit;
  }
  const startParam = url.searchParams.get('start');
  if (startParam !== null) {
    const start = Number(startParam);
    if (!Number.isSafeInteger(start) || start < 0 || start > MAX_TIMESTAMP_MILLISECONDS) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session list start must be a non-negative integer'
      );
    }
    params.start = start;
  }
  return params;
}

export async function handleSessionList(context: KiloFacadeHandlerContext): Promise<Response> {
  const query = parseSessionListQuery(context.url);
  if (query instanceof Response) return query;
  const sessions = query.gitUrl
    ? await context.env.SESSION_INGEST.listCloudAgentRootSessionsByGitUrl({
        ...query,
        gitUrl: query.gitUrl,
        kiloUserId: context.userId,
      })
    : await context.env.SESSION_INGEST.listCloudAgentRootSessions({
        ...query,
        kiloUserId: context.userId,
      });
  return Response.json(sessions.map(projectPublicListedSession));
}
