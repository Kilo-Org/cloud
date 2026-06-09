import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { isRecord } from '../../http-contract.js';
import {
  openSelectedRootLiveInteraction,
  readInteractionRequestBody,
} from '../../live-interaction.js';

export type SuggestionAction = Record<string, unknown> & {
  label: string;
  prompt: string;
  description?: string;
};

export type SuggestionRequest = Record<string, unknown> & {
  id: string;
  sessionID: string;
  text: string;
  actions: SuggestionAction[];
  blocking?: boolean;
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type SuggestionRoute =
  | { kind: 'list' }
  | { kind: 'accept'; requestID: string }
  | { kind: 'dismiss'; requestID: string };

export function parseSuggestionRoute(method: string, kiloPath: string): SuggestionRoute | null {
  if (method === 'GET' && kiloPath === '/suggestion') return { kind: 'list' };
  const match = /^\/suggestion\/([^/]+)\/(accept|dismiss)$/.exec(kiloPath);
  if (!match?.[1] || !match[2] || method !== 'POST') return null;
  let requestID: string;
  try {
    requestID = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!requestID) return null;
  return match[2] === 'accept' ? { kind: 'accept', requestID } : { kind: 'dismiss', requestID };
}

function isSuggestionAction(value: unknown): value is SuggestionAction {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.prompt === 'string' &&
    (value.description === undefined || typeof value.description === 'string')
  );
}

function isSuggestionTool(value: unknown): value is SuggestionRequest['tool'] {
  return isRecord(value) && typeof value.messageID === 'string' && typeof value.callID === 'string';
}

export function isSuggestionRequest(value: unknown): value is SuggestionRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.startsWith('sug') &&
    typeof value.sessionID === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.actions) &&
    value.actions.length >= 1 &&
    value.actions.length <= 2 &&
    value.actions.every(isSuggestionAction) &&
    (value.blocking === undefined || typeof value.blocking === 'boolean') &&
    (value.tool === undefined || isSuggestionTool(value.tool))
  );
}

function isSuggestionAcceptBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.index === 'number' &&
    Number.isInteger(value.index) &&
    value.index >= 0
  );
}

export async function handleSuggestion(
  context: KiloFacadeHandlerContext,
  route = parseSuggestionRoute(context.request.method, context.kiloPath)
): Promise<Response> {
  if (!route) throw new Error('Suggestion handler called for unsupported route');
  let body: Uint8Array | undefined;
  if (route.kind === 'accept') {
    const parsedBody = await readInteractionRequestBody(context.request, isSuggestionAcceptBody);
    if (parsedBody instanceof Response) return parsedBody;
    body = parsedBody;
  }

  const interaction = await openSelectedRootLiveInteraction(context);
  if (interaction instanceof Response) return interaction;

  if (route.kind === 'list') {
    const suggestions = await interaction.list({
      path: '/suggestion',
      isEntry: isSuggestionRequest,
    });
    return suggestions instanceof Response ? suggestions : Response.json(suggestions);
  }

  if (route.kind === 'accept') {
    return interaction.mutate({
      listPath: '/suggestion',
      mutationPath: `/suggestion/${encodeURIComponent(route.requestID)}/accept`,
      requestID: route.requestID,
      isEntry: isSuggestionRequest,
      body,
    });
  }

  return interaction.mutate({
    listPath: '/suggestion',
    mutationPath: `/suggestion/${encodeURIComponent(route.requestID)}/dismiss`,
    requestID: route.requestID,
    isEntry: isSuggestionRequest,
  });
}
