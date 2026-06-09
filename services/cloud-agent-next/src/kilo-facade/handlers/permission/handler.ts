import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { isRecord } from '../../http-contract.js';
import {
  openSelectedRootLiveInteraction,
  readInteractionRequestBody,
} from '../../live-interaction.js';

export type PermissionRequest = Record<string, unknown> & {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};

export type PermissionRoute =
  | { kind: 'list' }
  | { kind: 'reply'; requestID: string }
  | { kind: 'always-rules'; requestID: string };

export function parsePermissionRoute(method: string, kiloPath: string): PermissionRoute | null {
  if (method === 'GET' && kiloPath === '/permission') return { kind: 'list' };
  const match = /^\/permission\/([^/]+)\/(reply|always-rules)$/.exec(kiloPath);
  if (!match?.[1] || !match[2] || method !== 'POST') return null;
  let requestID: string;
  try {
    requestID = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!requestID) return null;
  return match[2] === 'reply' ? { kind: 'reply', requestID } : { kind: 'always-rules', requestID };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isPermissionTool(value: unknown): value is { messageID: string; callID: string } {
  return isRecord(value) && typeof value.messageID === 'string' && typeof value.callID === 'string';
}

export function isPermissionRequest(value: unknown): value is PermissionRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.startsWith('per') &&
    typeof value.sessionID === 'string' &&
    typeof value.permission === 'string' &&
    isStringArray(value.patterns) &&
    isRecord(value.metadata) &&
    !Array.isArray(value.metadata) &&
    isStringArray(value.always) &&
    (value.tool === undefined || isPermissionTool(value.tool))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function isPermissionReplyBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(['reply', 'message'])) &&
    (value.reply === 'once' || value.reply === 'always' || value.reply === 'reject') &&
    (value.message === undefined || typeof value.message === 'string')
  );
}

function isPermissionAlwaysRulesBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(['approvedAlways', 'deniedAlways'])) &&
    (value.approvedAlways === undefined || isStringArray(value.approvedAlways)) &&
    (value.deniedAlways === undefined || isStringArray(value.deniedAlways))
  );
}

export async function handlePermission(
  context: KiloFacadeHandlerContext,
  route = parsePermissionRoute(context.request.method, context.kiloPath)
): Promise<Response> {
  if (!route) throw new Error('Permission handler called for unsupported route');

  let body: Uint8Array | undefined;
  if (route.kind === 'reply') {
    const parsedBody = await readInteractionRequestBody(context.request, isPermissionReplyBody);
    if (parsedBody instanceof Response) return parsedBody;
    body = parsedBody;
  } else if (route.kind === 'always-rules') {
    const parsedBody = await readInteractionRequestBody(
      context.request,
      isPermissionAlwaysRulesBody
    );
    if (parsedBody instanceof Response) return parsedBody;
    body = parsedBody;
  }

  const interaction = await openSelectedRootLiveInteraction(context);
  if (interaction instanceof Response) return interaction;

  if (route.kind === 'list') {
    const permissions = await interaction.list({
      path: '/permission',
      isEntry: isPermissionRequest,
    });
    return permissions instanceof Response ? permissions : Response.json(permissions);
  }

  return interaction.mutate({
    listPath: '/permission',
    mutationPath: `/permission/${encodeURIComponent(route.requestID)}/${route.kind === 'reply' ? 'reply' : 'always-rules'}`,
    requestID: route.requestID,
    isEntry: isPermissionRequest,
    ...(body ? { body } : {}),
  });
}
