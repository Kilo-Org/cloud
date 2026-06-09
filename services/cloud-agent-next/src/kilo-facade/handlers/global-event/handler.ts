import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { facadeError, unsupportedRouteResponse } from '../../http-contract.js';

export function handleGlobalEvent(context: KiloFacadeHandlerContext): Response {
  if (context.request.method !== 'GET') return unsupportedRouteResponse();
  if (context.url.search.length > 0) {
    return facadeError(
      400,
      'KILO_EVENT_SELECTOR_UNSUPPORTED',
      'Global event selectors are not supported'
    );
  }
  const globalEvents = context.deps?.globalEvents;
  if (!globalEvents) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade stream is unavailable');
  }
  return globalEvents.openPublicGlobalEventStream(context.userId);
}
