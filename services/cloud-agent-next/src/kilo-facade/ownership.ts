import type { KiloFacadeHandlerContext, SelectedOwnedRootHandlerContext } from './contracts.js';
import {
  isSessionIngestKiloSessionId,
  missingRootKiloSessionResponse,
  parsePublicSessionDirectory,
  unsupportedSessionSelectorResponse,
} from './http-contract.js';
import { hasDuplicateQueryParameters } from '../shared/http-query.js';

export function resolveRootSessionForKiloSession(
  context: KiloFacadeHandlerContext,
  kiloSessionId: string
): Promise<{ cloudAgentSessionId: string } | null> {
  if (context.deps?.resolveRootSessionForKiloSession) {
    return context.deps.resolveRootSessionForKiloSession({
      env: context.env,
      userId: context.userId,
      kiloSessionId,
    });
  }
  return context.env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession({
    kiloUserId: context.userId,
    kiloSessionId,
  });
}

export async function resolveSelectedOwnedRoot(
  context: KiloFacadeHandlerContext
): Promise<SelectedOwnedRootHandlerContext | Response> {
  if (
    [...context.url.searchParams.keys()].some(key => key !== 'directory') ||
    hasDuplicateQueryParameters(context.url.searchParams)
  ) {
    return unsupportedSessionSelectorResponse();
  }

  const directory = context.url.searchParams.get('directory');
  if (directory === null) return unsupportedSessionSelectorResponse();
  const kiloSessionId = parsePublicSessionDirectory(directory);
  if (!kiloSessionId) return unsupportedSessionSelectorResponse();
  if (!isSessionIngestKiloSessionId(kiloSessionId)) return missingRootKiloSessionResponse();

  const root = await resolveRootSessionForKiloSession(context, kiloSessionId);
  if (!root) return missingRootKiloSessionResponse();
  return { ...context, kiloSessionId, cloudAgentSessionId: root.cloudAgentSessionId };
}
