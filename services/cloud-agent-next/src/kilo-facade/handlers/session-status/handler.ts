import { hasDuplicateQueryParameters } from '../../../shared/http-query.js';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import {
  duplicateQueryParametersResponse,
  facadeError,
  isSessionIngestKiloSessionId,
  missingRootKiloSessionResponse,
  parsePublicSessionDirectory,
  unsupportedSessionSelectorResponse,
} from '../../http-contract.js';
import { resolveRootSessionForKiloSession } from '../../ownership.js';

export async function handleSessionStatus(context: KiloFacadeHandlerContext): Promise<Response> {
  if ([...context.url.searchParams.keys()].some(key => key !== 'directory')) {
    return unsupportedSessionSelectorResponse();
  }
  if (hasDuplicateQueryParameters(context.url.searchParams)) {
    return duplicateQueryParametersResponse();
  }

  let selectedKiloSessionId: string | undefined;
  const directory = context.url.searchParams.get('directory');
  if (directory !== null) {
    selectedKiloSessionId = parsePublicSessionDirectory(directory) ?? undefined;
    if (!selectedKiloSessionId) return unsupportedSessionSelectorResponse();
    if (!isSessionIngestKiloSessionId(selectedKiloSessionId)) {
      return missingRootKiloSessionResponse();
    }
    const root = await resolveRootSessionForKiloSession(context, selectedKiloSessionId);
    if (!root) return missingRootKiloSessionResponse();
  }

  const globalEvents = context.deps?.globalEvents;
  if (!globalEvents?.getPublicSessionStatuses) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade status is unavailable');
  }
  return Response.json(
    selectedKiloSessionId
      ? globalEvents.getPublicSessionStatuses(selectedKiloSessionId)
      : globalEvents.getPublicSessionStatuses()
  );
}
