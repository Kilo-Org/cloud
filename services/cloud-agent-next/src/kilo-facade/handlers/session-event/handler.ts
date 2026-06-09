import { hasDuplicateQueryParameters } from '../../../shared/http-query.js';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import {
  duplicateQueryParametersResponse,
  facadeError,
  isSessionIngestKiloSessionId,
  missingRootKiloSessionResponse,
  parsePublicSessionDirectory,
  unsupportedRouteResponse,
} from '../../http-contract.js';
import { resolveRootSessionForKiloSession } from '../../ownership.js';

export async function handleSessionEvent(context: KiloFacadeHandlerContext): Promise<Response> {
  if (context.request.method !== 'GET') return unsupportedRouteResponse();
  if ([...context.url.searchParams.keys()].some(key => key !== 'directory')) {
    return facadeError(
      400,
      'KILO_EVENT_SELECTOR_UNSUPPORTED',
      'Only the Cloud Agent session directory selector is supported'
    );
  }
  if (hasDuplicateQueryParameters(context.url.searchParams)) {
    return duplicateQueryParametersResponse();
  }
  const directory = context.url.searchParams.get('directory');
  if (!directory) {
    return facadeError(
      400,
      'KILO_EVENT_DIRECTORY_REQUIRED',
      'A Cloud Agent session directory selector is required'
    );
  }
  const kiloSessionId = parsePublicSessionDirectory(directory);
  if (!kiloSessionId) {
    return facadeError(
      400,
      'KILO_EVENT_SELECTOR_UNSUPPORTED',
      'Only a Cloud Agent root session directory selector is supported'
    );
  }
  if (!isSessionIngestKiloSessionId(kiloSessionId)) return missingRootKiloSessionResponse();
  const root = await resolveRootSessionForKiloSession(context, kiloSessionId);
  if (!root) return missingRootKiloSessionResponse();
  const globalEvents = context.deps?.globalEvents;
  if (!globalEvents) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade stream is unavailable');
  }
  return globalEvents.openPublicSessionEventStream(context.userId, kiloSessionId);
}
