import type { Env } from '../types.js';
import type {
  KiloFacadeHandlerContext,
  KiloFacadeRequestDeps,
  OwnedRootHandlerContext,
} from './contracts.js';
import { handleAbort } from './handlers/abort/handler.js';
import { handleCommandList } from './handlers/command-list/handler.js';
import { handleCommand } from './handlers/command/handler.js';
import { handleGlobalEvent } from './handlers/global-event/handler.js';
import { handlePermission, parsePermissionRoute } from './handlers/permission/handler.js';
import { handlePromptAsync } from './handlers/prompt-async/handler.js';
import { handleQuestion, parseQuestionRoute } from './handlers/question/handler.js';
import { handleSessionDetail } from './handlers/session-detail/handler.js';
import { handleSessionEvent } from './handlers/session-event/handler.js';
import { handleSessionList } from './handlers/session-list/handler.js';
import { handleSessionMessage } from './handlers/session-message/handler.js';
import { handleSessionMessages } from './handlers/session-messages/handler.js';
import { handleSessionStatus } from './handlers/session-status/handler.js';
import { handleSuggestion, parseSuggestionRoute } from './handlers/suggestion/handler.js';
import {
  facadeError,
  isSessionIngestKiloSessionId,
  kiloRelativePath,
  missingRootKiloSessionResponse,
  parseRootSessionRoute,
  unsupportedRouteResponse,
} from './http-contract.js';
import { resolveRootSessionForKiloSession } from './ownership.js';

const KNOWN_UNSUPPORTED_ROUTES = new Set([
  'POST /session/viewed',
  'POST /sync/history',
  'GET /config',
  'GET /provider',
  'GET /project/current',
  'GET /global/health',
]);

type OwnedRootRoute =
  | { kind: 'detail' }
  | { kind: 'messages' }
  | { kind: 'message'; messageId: string }
  | { kind: 'prompt-async' }
  | { kind: 'command' }
  | { kind: 'abort' };

function classifyOwnedRootRoute(
  method: string,
  kiloPath: string,
  encodedKiloSessionId: string
): OwnedRootRoute | null {
  const exactRoute = `/session/${encodedKiloSessionId}`;
  if (method === 'GET' && kiloPath === exactRoute) return { kind: 'detail' };
  if (method === 'GET' && kiloPath === `${exactRoute}/message`) return { kind: 'messages' };
  if (method === 'GET') {
    const messageMatch = /^\/message\/([^/]+)$/.exec(kiloPath.slice(exactRoute.length));
    if (messageMatch?.[1]) {
      try {
        return { kind: 'message', messageId: decodeURIComponent(messageMatch[1]) };
      } catch {
        return null;
      }
    }
  }
  if (method === 'POST' && kiloPath === `${exactRoute}/prompt_async`)
    return { kind: 'prompt-async' };
  if (method === 'POST' && kiloPath === `${exactRoute}/command`) return { kind: 'command' };
  if (method === 'POST' && kiloPath === `${exactRoute}/abort`) return { kind: 'abort' };
  return null;
}

export async function handleKiloFacadeRequest(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  const url = new URL(params.request.url);
  const context: KiloFacadeHandlerContext = {
    ...params,
    url,
    kiloPath: kiloRelativePath(url.pathname),
  };

  if (context.kiloPath === '/global/event') return handleGlobalEvent(context);
  if (context.kiloPath === '/event') return handleSessionEvent(context);
  if (context.kiloPath === '/session/status') {
    return context.request.method === 'GET'
      ? handleSessionStatus(context)
      : unsupportedRouteResponse();
  }
  if (context.kiloPath === '/command') {
    return context.request.method === 'GET'
      ? handleCommandList(context)
      : unsupportedRouteResponse();
  }
  if (context.kiloPath === '/session' && context.request.method === 'GET') {
    return handleSessionList(context);
  }
  const questionRoute = parseQuestionRoute(context.request.method, context.kiloPath);
  if (questionRoute) return handleQuestion(context, questionRoute);
  const permissionRoute = parsePermissionRoute(context.request.method, context.kiloPath);
  if (permissionRoute) return handlePermission(context, permissionRoute);
  const suggestionRoute = parseSuggestionRoute(context.request.method, context.kiloPath);
  if (suggestionRoute) return handleSuggestion(context, suggestionRoute);
  if (
    context.kiloPath === '/session' ||
    KNOWN_UNSUPPORTED_ROUTES.has(`${context.request.method} ${context.kiloPath}`)
  ) {
    return unsupportedRouteResponse();
  }

  const route = parseRootSessionRoute(context.kiloPath);
  if (!route) return unsupportedRouteResponse();
  if (!isSessionIngestKiloSessionId(route.kiloSessionId)) return missingRootKiloSessionResponse();

  const root = await resolveRootSessionForKiloSession(context, route.kiloSessionId);
  if (!root) return missingRootKiloSessionResponse();

  const ownedRoute = classifyOwnedRootRoute(
    context.request.method,
    context.kiloPath,
    route.encodedKiloSessionId
  );
  if (context.deps?.decideSessionRoute) {
    const decision = context.deps.decideSessionRoute({
      method: context.request.method,
      kiloRelativePath: context.kiloPath,
      search: context.url.search,
      userId: context.userId,
      kiloSessionId: route.kiloSessionId,
      cloudAgentSessionId: root.cloudAgentSessionId,
    });
    if (decision.kind === 'reject') {
      return facadeError(decision.status, decision.code, decision.message);
    }
  }
  if (!ownedRoute) return unsupportedRouteResponse();

  const ownedContext: OwnedRootHandlerContext = {
    ...context,
    ...route,
    cloudAgentSessionId: root.cloudAgentSessionId,
  };
  switch (ownedRoute.kind) {
    case 'detail':
      return handleSessionDetail(ownedContext);
    case 'messages':
      return handleSessionMessages(ownedContext);
    case 'message':
      return handleSessionMessage(ownedContext, ownedRoute.messageId);
    case 'prompt-async':
      return handlePromptAsync(ownedContext);
    case 'command':
      return handleCommand(ownedContext);
    case 'abort':
      return handleAbort(ownedContext);
  }
}
