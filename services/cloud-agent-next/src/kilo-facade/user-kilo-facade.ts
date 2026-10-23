import { cli_sessions_v2, organization_memberships } from '@kilocode/db/schema';
import { logger } from '../logger.js';
import {
  cloudAgentWorktreeIdSchema,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  validateKiloSdkMessagesCursor,
} from '@kilocode/session-ingest-contracts';
import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_DO_RETRY_CONFIG } from '@kilocode/worker-utils';
import { TRPCError } from '@trpc/server';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type {
  GetCloudAgentRootSessionMessagesParams,
  ListCloudAgentRootSessionsParams,
} from '../session-ingest-binding.js';
import {
  fetchOrgIdForSession,
  validateBalanceOnly,
  type BalanceOnlyResult,
} from '../balance-validation.js';
import type {
  QueueExecutionTurnCommand,
  SubmittedSessionMessageRequest,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import { getPgDb } from '../db/pg.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import {
  buildControlPlaneMessagePayload,
  ControlPlaneMessageInputError,
} from '../session/control-plane-session-input.js';
import { fetchSessionMetadata } from '../session/metadata.js';
import { isControlSession } from '../session-identity.js';
import type { SessionId } from '../types/ids.js';
import type {
  ControlPlaneSendResult,
  NativeSnapshot,
  SandboxSessionV2,
} from '../control-plane/session/session-do.js';
import type {
  ControlPlaneAnswerReply,
  ControlPlaneControlResult,
  ControlPlaneDispatchResult,
} from '../shared/control-plane-protocol.js';
import { createMessageId } from '../session/message-id.js';
import { interruptControlSession } from '../router/control-plane-session.js';
import {
  preflightAndAdmitPromptMessage,
  pendingQueueFullAdmissionFailure,
} from '../session/queue-message.js';
import { parseBasicKiloPrompt } from './basic-prompt.js';
import {
  readNativeLiveOperation,
  type NativeLiveReader,
  type NativeReadOutcome,
} from './native-live.js';
import {
  canRetainNativeEvent,
  createNativeAttachmentRegistry,
  isDeliverableNativeEvent,
  NATIVE_FACADE_FENCE_EVENT,
  NATIVE_FACADE_RESNAPSHOT_EVENT,
  toNativePublicEvent,
  type NativeEventBatch,
  type NativeEventContinuity,
  type NativeEventSubscription,
  NATIVE_DELIVERY_LIMITS,
  type NativePublicEvent,
} from './native-event-source.js';
import {
  classifyNativeRoute,
  parseNativeAnswerBody,
  parseNativeCommandBody,
  type NativeSessionRoute,
} from './native-routes.js';
import { type PublicCloudAgentExtensionEvent } from './cloud-agent-extension-events.js';
import { hasDuplicateQueryParameters } from '../shared/http-query.js';
import {
  projectPublicListedSession,
  projectPublicSession,
  projectPublicStoredMessages,
  publicCloudAgentDirectory,
} from './public-sdk-projection.js';

export const KILO_FACADE_USER_ID_HEADER = 'x-kilo-facade-user-id';
export const KILO_FACADE_AUTH_TOKEN_HEADER = 'x-kilo-facade-auth-token';

export const KILO_FACADE_GLOBAL_FEED_PATH = '/internal/kilo/global-feed';
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_PUBLIC_GLOBAL_EVENT_QUEUE_SIZE = 64;
const SLOW_SUBSCRIBER_ERROR = 'Global event subscriber fell behind';
const SUPPORTED_SESSION_LIST_QUERY_PARAMS = new Set(['limit', 'start']);
const SUPPORTED_SESSION_MESSAGES_QUERY_PARAMS = new Set(['directory', 'limit', 'before']);
const KNOWN_UNSUPPORTED_ROUTES = new Set([
  'POST /session/viewed',
  'POST /sync/history',
  'GET /config',
  'GET /provider',
  'GET /project/current',
  'GET /global/health',
]);
const MAX_KILO_PROMPT_JSON_BYTES = 256 * 1024;
const MAX_TIMESTAMP_MILLISECONDS = 8_640_000_000_000_000;
const MAX_PUBLIC_SESSION_TITLE_CHARACTERS = 512;
const PUBLIC_VIRTUAL_SERVER_DIRECTORY = '/cloud-agent';

type KiloEventPayload = Record<string, unknown> & {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
};

type KiloGlobalEventEnvelope = Record<string, unknown> & {
  directory?: string;
  project?: unknown;
  workspace?: unknown;
  payload?: KiloEventPayload;
};

type PublicSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  scope: { kind: 'global' } | { kind: 'session'; kiloSessionId: string };
};

export type KiloFacadeGlobalEvents = {
  openPublicGlobalEventStream(userId?: string): Response;
  openPublicSessionEventStream(
    kiloSessionId: string,
    native?: {
      fence?: number | null;
      resnapshot?: boolean;
      snapshot?: NativePublicEvent[];
      attachmentId?: string;
      nextPage?: () => Promise<NativeAttachOutcome>;
      continuity?: NativeEventContinuity;
    }
  ): Response;
};

export type KiloFacadeRequestDeps = {
  resolveRootSessionForKiloSession?: (params: {
    env: Env;
    userId: string;
    kiloSessionId: string;
  }) => Promise<{ cloudAgentSessionId: string } | null>;
  admitPrompt?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    request: SubmittedSessionMessageRequest;
  }) => Promise<SessionMessageAdmissionResult>;
  validatePromptBalance?: (params: {
    env: Env;
    authToken: string;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<BalanceOnlyResult>;
  interruptPrompt?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<{ success: boolean; message?: string }>;
  /**
   * Performs one allowlisted native read against the selected hosted session.
   * Production resolves it to the Session DO; it never wakes compute.
   */
  nativeLiveRead?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    operation: Parameters<NativeLiveReader>[0];
  }) => Promise<ControlPlaneControlResult>;
  /**
   * Performs the native attach: subscribe to the hosted session's stored-event
   * push, then read the durable snapshot through the snapshot fence.
   */
  openNativeAttachment?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    attachmentId?: string;
  }) => Promise<NativeAttachOutcome>;
  globalEvents?: KiloFacadeGlobalEvents;
};

/** Result of one fenced native attach. */
export type NativeAttachOutcome =
  | {
      kind: 'fenced';
      fence: number | null;
      events: NativePublicEvent[];
      snapshot: NativeSnapshot;
      nextPage?: () => Promise<NativeAttachOutcome>;
      continuity?: NativeEventContinuity;
    }
  | { kind: 'stopped' }
  | { kind: 'resnapshot' }
  | { kind: 'unavailable'; code: string; message: string; retryable: boolean };

async function defaultOpenNativeAttachment(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  attachmentId?: string;
}): Promise<NativeAttachOutcome> {
  const stub = getSandboxSessionStub(params.env, params.userId, params.cloudAgentSessionId);
  let subscription: NativeEventSubscription;
  try {
    subscription = await withDORetry<DurableObjectStub<SandboxSessionV2>, NativeEventSubscription>(
      () => stub,
      current =>
        current.subscribeNativeEvents({
          kiloSessionId: params.kiloSessionId,
          attachmentId: params.attachmentId ?? params.kiloSessionId,
        }),
      'subscribeNativeEvents'
    );
  } catch {
    return {
      kind: 'unavailable',
      code: 'KILO_SESSION_READ_RETRYABLE',
      message: 'Native event stream is unavailable',
      retryable: true,
    };
  }
  if (!subscription.registered) return { kind: 'stopped' };
  const readPage = async (
    continuation?: NativeSnapshot['continuation']
  ): Promise<NativeAttachOutcome> => {
    const snapshot = await withDORetry<DurableObjectStub<SandboxSessionV2>, NativeSnapshot>(
      () => stub,
      current => current.nativeSnapshot({ continuation }),
      'nativeSnapshot'
    );
    if (snapshot.oversized) return { kind: 'resnapshot' };
    const events: NativePublicEvent[] = [];
    for (const event of snapshot.events) {
      if (!isDeliverableNativeEvent(event)) continue;
      const native = toNativePublicEvent(event, params.kiloSessionId);
      if (native !== null) events.push(native);
    }
    return {
      kind: 'fenced',
      fence: snapshot.fence,
      events,
      snapshot,
      continuity: subscription.continuity,
      ...(snapshot.continuation === undefined
        ? {}
        : { nextPage: () => readPage(snapshot.continuation) }),
    };
  };
  return readPage();
}

const encoder = new TextEncoder();

function facadeError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, number>
): Response {
  return Response.json({ error: code, message, ...details }, { status });
}

function kiloRelativePath(pathname: string): string {
  if (pathname === '/kilo') {
    return '/';
  }
  if (pathname.startsWith('/kilo/')) {
    return pathname.slice('/kilo'.length);
  }
  return pathname;
}

function parseRootSessionRoute(kiloPath: string): {
  encodedKiloSessionId: string;
  kiloSessionId: string;
} | null {
  const match = /^\/session\/([^/]+)(?:\/.*)?$/.exec(kiloPath);
  if (!match?.[1]) {
    return null;
  }
  try {
    return {
      encodedKiloSessionId: match[1],
      kiloSessionId: decodeURIComponent(match[1]),
    };
  } catch {
    return null;
  }
}

function isSessionIngestKiloSessionId(kiloSessionId: string): boolean {
  return kiloSessionId.startsWith('ses_') && kiloSessionId.length === 30;
}

function missingRootKiloSessionResponse(): Response {
  return facadeError(404, 'KILO_SESSION_NOT_FOUND', 'Cloud Agent root Kilo session was not found');
}

function pendingSessionSnapshotResponse(): Response {
  const response = facadeError(
    503,
    'KILO_SESSION_SNAPSHOT_PENDING',
    'Cloud Agent Kilo session snapshot is not available yet'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

function sessionSnapshotTooLargeResponse(): Response {
  return facadeError(
    413,
    'KILO_SESSION_SNAPSHOT_TOO_LARGE',
    'Persisted Kilo session snapshot exceeds the safe cold-read budget'
  );
}

function retryableSessionReadResponse(): Response {
  const response = facadeError(
    503,
    'KILO_SESSION_READ_RETRYABLE',
    'Persisted Kilo session data is temporarily unavailable; retry the request'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

function invalidPersistedSessionDataResponse(entity: 'session' | 'messages'): Response {
  return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', `Kilo ${entity} response is not valid`);
}

function transcriptTooLargeResponse(): Response {
  return facadeError(
    413,
    'KILO_TRANSCRIPT_TOO_LARGE',
    'Persisted Kilo transcript exceeds the safe cold-read budget; use smaller bounded history when possible, or retry while a live runtime is available'
  );
}

function createPublicEventPayload(type: 'server.connected'): KiloEventPayload {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type,
    properties: {},
  };
}

export { publicCloudAgentDirectory };

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array | null> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    if (byteLength + value.byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function duplicateQueryParametersResponse(): Response {
  return facadeError(400, 'KILO_QUERY_INVALID', 'Query parameters must be unique');
}

function parseSessionListQuery(
  url: URL
): Omit<ListCloudAgentRootSessionsParams, 'kiloUserId'> | Response {
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_SESSION_LIST_QUERY_PARAMS.has(key)) {
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

  const params: Omit<ListCloudAgentRootSessionsParams, 'kiloUserId'> = {};
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

function unsupportedSessionSelectorResponse(): Response {
  return facadeError(
    400,
    'KILO_SESSION_SELECTOR_UNSUPPORTED',
    'Only the matching public Cloud Agent session directory selector is supported'
  );
}

function validateIdScopedSelectors(
  url: URL,
  kiloSessionId: string,
  paginationKeys: Set<string>
): Response | null {
  for (const key of url.searchParams.keys()) {
    if (paginationKeys.has(key)) continue;
    if (key !== 'directory') return unsupportedSessionSelectorResponse();
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }
  const directory = url.searchParams.get('directory');
  if (directory !== null && directory !== publicCloudAgentDirectory(kiloSessionId)) {
    return unsupportedSessionSelectorResponse();
  }
  return null;
}

function parseSessionMessagesQuery(
  url: URL
): Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'> | Response {
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_SESSION_MESSAGES_QUERY_PARAMS.has(key)) {
      return unsupportedSessionSelectorResponse();
    }
  }
  const params: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'> = {};
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        `Session messages limit must be an integer from 0 to ${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE}`
      );
    }
    params.limit = limit;
  }
  const before = url.searchParams.get('before');
  if (before !== null) {
    if (before.length === 0 || params.limit === undefined || params.limit === 0) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session messages before requires a positive limit'
      );
    }
    if (!validateKiloSdkMessagesCursor(before)) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session messages before is not a valid cursor'
      );
    }
    params.before = before;
  }
  return params;
}

function isExactSessionDetailRead(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'GET' && kiloPath === `/session/${routePath}`;
}

function isExactSessionMessagesRead(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'GET' && kiloPath === `/session/${routePath}/message`;
}

function isExactSessionPromptAsync(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'POST' && kiloPath === `/session/${routePath}/prompt_async`;
}

function isExactSessionAbort(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'POST' && kiloPath === `/session/${routePath}/abort`;
}

function promptAdmissionError(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): Response {
  switch (result.code) {
    case 'BAD_REQUEST':
      return facadeError(400, 'KILO_PROMPT_ADMISSION_REJECTED', result.error);
    case 'FORBIDDEN':
      return facadeError(403, 'KILO_PROMPT_ADMISSION_REJECTED', result.error);
    case 'MODEL_VALIDATION_UNAVAILABLE':
      return facadeError(503, result.code, result.error);
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'PENDING_QUEUE_FULL':
      return facadeError(429, 'KILO_PROMPT_QUEUE_FULL', result.error);
    case 'PAYMENT_REQUIRED':
      return facadeError(402, 'KILO_PROMPT_PAYMENT_REQUIRED', result.error);
    case 'COMPUTE_STOPPING':
      return facadeError(409, 'KILO_BILLING_BLOCKED', 'Cloud Agent is saving and stopping compute');
    case 'BILLING_UNAVAILABLE':
      return facadeError(
        503,
        'KILO_BILLING_UNAVAILABLE',
        'Cloud Agent cannot verify compute billing right now'
      );
    case 'SANDBOX_CONNECT_FAILED':
    case 'WORKSPACE_SETUP_FAILED':
    case 'KILO_SERVER_FAILED':
    case 'WRAPPER_START_FAILED':
    case 'WRAPPER_FINALIZING':
      return facadeError(503, result.code, result.error);
    case 'INTERNAL':
      return facadeError(500, 'KILO_PROMPT_ADMISSION_FAILED', result.error);
  }
}

function promptPreflightError(error: unknown): Response {
  if (!(error instanceof TRPCError)) throw error;
  switch (error.code) {
    case 'BAD_REQUEST':
      return facadeError(400, 'KILO_PROMPT_ADMISSION_REJECTED', error.message);
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'FORBIDDEN':
      return facadeError(403, 'KILO_PROMPT_ADMISSION_REJECTED', error.message);
    case 'SERVICE_UNAVAILABLE':
      return facadeError(503, 'MODEL_VALIDATION_UNAVAILABLE', error.message);
    default:
      throw error;
  }
}

type ReadRequestJsonResult =
  | { success: true; value: unknown }
  | { success: false; response: Response };

async function readRequestJson(request: Request): Promise<ReadRequestJsonResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_PROMPT_JSON_BYTES) {
      return {
        success: false,
        response: facadeError(
          400,
          'KILO_BASIC_PROMPT_UNSUPPORTED',
          'Basic Kilo prompt body is not supported'
        ),
      };
    }
  }
  const response = new Response(request.body);
  const bytes = await readBoundedBody(response, MAX_KILO_PROMPT_JSON_BYTES);
  if (!bytes) {
    return {
      success: false,
      response: facadeError(
        400,
        'KILO_BASIC_PROMPT_UNSUPPORTED',
        'Basic Kilo prompt body is not supported'
      ),
    };
  }
  try {
    return { success: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      success: false,
      response: facadeError(
        400,
        'KILO_BASIC_PROMPT_UNSUPPORTED',
        'Basic Kilo prompt body is not supported'
      ),
    };
  }
}

async function defaultValidatePromptBalance(params: {
  env: Env;
  authToken: string;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<BalanceOnlyResult> {
  const orgId = await fetchOrgIdForSession(params.env, params.userId, params.cloudAgentSessionId);
  return validateBalanceOnly(params.authToken, orgId, params.env);
}

async function defaultAdmitPrompt(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  request: SubmittedSessionMessageRequest;
}): Promise<SessionMessageAdmissionResult> {
  const sessionId = params.cloudAgentSessionId as SessionId;
  const metadata = await fetchSessionMetadata(params.env, params.userId, sessionId);
  if (!metadata) return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
  let payload;
  try {
    payload = await buildControlPlaneMessagePayload({
      env: params.env,
      userId: params.userId,
      sessionId,
      metadata,
      turn: params.request.turn,
      ...(params.request.finalization === undefined
        ? {}
        : { finalization: params.request.finalization }),
      ...(params.request.agent === undefined ? {} : { agentOverride: params.request.agent }),
    });
  } catch (error) {
    return {
      success: false,
      code: 'BAD_REQUEST',
      error: error instanceof ControlPlaneMessageInputError ? error.detail : 'Invalid message',
    };
  }
  const result = await withDORetry<DurableObjectStub<SandboxSessionV2>, ControlPlaneSendResult>(
    () => getSandboxSessionStub(params.env, params.userId, sessionId),
    stub => stub.send(payload),
    'send'
  );
  if (result.type === 'session-not-found') {
    return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
  }
  if (result.type === 'queue-full') {
    return pendingQueueFullAdmissionFailure();
  }
  return {
    success: true,
    outcome: 'queued',
    compatibilityDelivery: 'queued',
    messageId: payload.messageId,
  };
}

async function admitBasicPrompt(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  cloudAgentSessionId: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<SessionMessageAdmissionResult | Response> {
  const body = await readRequestJson(params.request);
  if (!body.success) {
    return body.response;
  }
  const parsed = parseBasicKiloPrompt(body.value);
  if (!parsed.success) {
    return facadeError(
      400,
      'KILO_BASIC_PROMPT_UNSUPPORTED',
      'Basic Kilo prompt body is not supported'
    );
  }
  if (!params.authToken) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Durable prompt admission is unavailable');
  }
  if (params.request.headers.get('x-skip-balance-check') !== null) {
    return facadeError(
      400,
      'KILO_BALANCE_BYPASS_UNSUPPORTED',
      'Balance bypass is not supported for public Kilo prompt mutations'
    );
  }
  const balance = await (params.deps?.validatePromptBalance ?? defaultValidatePromptBalance)({
    env: params.env,
    authToken: params.authToken,
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
  });
  if (!balance.success) {
    return facadeError(balance.status, 'KILO_BALANCE_VALIDATION_FAILED', balance.message);
  }
  const command = {
    turn: {
      type: 'prompt',
      id: parsed.prompt.messageId,
      prompt: parsed.prompt.prompt,
    },
    ...(parsed.prompt.agent ? { agent: parsed.prompt.agent } : {}),
  } satisfies QueueExecutionTurnCommand;
  const request: SubmittedSessionMessageRequest = {
    userId: params.userId,
    ...command,
  };
  const admitPrompt = params.deps?.admitPrompt ?? defaultAdmitPrompt;
  try {
    return await preflightAndAdmitPromptMessage(
      { cloudAgentSessionId: params.cloudAgentSessionId, ...command },
      { env: params.env, userId: params.userId, authToken: params.authToken },
      'kilo.prompt_async',
      () =>
        admitPrompt({
          env: params.env,
          userId: params.userId,
          cloudAgentSessionId: params.cloudAgentSessionId,
          request,
        })
    );
  } catch (error) {
    return promptPreflightError(error);
  }
}

async function handlePromptAsyncMutation(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  cloudAgentSessionId: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  const admission = await admitBasicPrompt(params);
  if (admission instanceof Response) {
    return admission;
  }
  if (!admission.success) {
    return promptAdmissionError(admission);
  }
  return new Response(null, { status: 204 });
}

async function defaultInterruptPrompt(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<{ success: boolean; message?: string }> {
  const receipt = await interruptControlSession({
    env: params.env,
    ownerId: params.userId,
    sessionId: params.cloudAgentSessionId,
  });
  return receipt?.state === 'rejected'
    ? { success: false, message: receipt.message }
    : {
        success: receipt !== undefined,
        ...(receipt ? {} : { message: 'No session work to interrupt' }),
      };
}

async function handleAbortMutation(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  await (params.deps?.interruptPrompt ?? defaultInterruptPrompt)({
    env: params.env,
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
  });
  return Response.json(true);
}

function messagesPageResponse(
  requestUrl: URL,
  messages: unknown,
  nextCursor: string | null,
  omittedItemCount: number
): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'X-Kilo-Omitted-Item-Count': String(omittedItemCount),
  });
  if (nextCursor !== null) {
    const nextUrl = new URL(requestUrl);
    nextUrl.searchParams.set('before', nextCursor);
    headers.set('Link', `<${nextUrl.toString()}>; rel="next"`);
    headers.set('X-Next-Cursor', nextCursor);
  }
  return new Response(JSON.stringify(messages), { headers });
}

async function persistedSessionDetailResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
}): Promise<Response> {
  const snapshot = await params.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
  });
  if (!snapshot) {
    return missingRootKiloSessionResponse();
  }
  switch (snapshot.snapshot.kind) {
    case 'pending':
      return pendingSessionSnapshotResponse();
    case 'too_large':
      return sessionSnapshotTooLargeResponse();
    case 'retryable_failure':
      return retryableSessionReadResponse();
    case 'invalid_data':
      return invalidPersistedSessionDataResponse('session');
    case 'value':
      return Response.json(projectPublicSession(snapshot.snapshot.info, snapshot.kiloSessionId));
  }
}

function publicRepositoryTitle(repositoryUrl: string | null): string | null {
  if (!repositoryUrl) return null;
  try {
    const repository = new URL(repositoryUrl);
    if (repository.protocol !== 'https:' || repository.username || repository.password) return null;
    const title = repository.pathname.split('/').filter(Boolean).slice(-2).join('/');
    return title.replace(/\.git$/, '') || null;
  } catch {
    return null;
  }
}

async function groupedPendingSessionDetailResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
  cloudAgentSessionId: string;
}): Promise<Response | null> {
  const snapshot = await params.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
  });
  if (
    !snapshot ||
    snapshot.kiloSessionId !== params.kiloSessionId ||
    snapshot.cloudAgentSessionId !== params.cloudAgentSessionId
  ) {
    return missingRootKiloSessionResponse();
  }
  if (snapshot.snapshot.kind !== 'pending') return null;

  const [ownership] = await getPgDb(params.env)
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      userId: cli_sessions_v2.kilo_user_id,
      organizationId: cli_sessions_v2.organization_id,
      organizationMembershipId: organization_memberships.id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
      title: cli_sessions_v2.title,
      repositoryUrl: cli_sessions_v2.git_url,
      createdAt: cli_sessions_v2.created_at,
      updatedAt: cli_sessions_v2.updated_at,
    })
    .from(cli_sessions_v2)
    .leftJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, cli_sessions_v2.organization_id),
        eq(organization_memberships.kilo_user_id, params.userId)
      )
    )
    .where(
      and(
        eq(cli_sessions_v2.session_id, params.kiloSessionId),
        eq(cli_sessions_v2.kilo_user_id, params.userId),
        eq(cli_sessions_v2.cloud_agent_session_id, params.cloudAgentSessionId),
        isNull(cli_sessions_v2.parent_session_id),
        or(isNull(cli_sessions_v2.organization_id), isNotNull(organization_memberships.id))
      )
    )
    .limit(1);

  if (
    !ownership ||
    ownership.userId !== params.userId ||
    ownership.kiloSessionId !== params.kiloSessionId ||
    ownership.cloudAgentSessionId !== params.cloudAgentSessionId ||
    (ownership.organizationId !== null && ownership.organizationMembershipId === null)
  ) {
    return missingRootKiloSessionResponse();
  }
  if (
    ownership.cloudAgentSessionScopeId !== params.cloudAgentSessionId ||
    !cloudAgentWorktreeIdSchema.safeParse(ownership.worktreeId).success
  ) {
    return null;
  }

  const created = new Date(ownership.createdAt).getTime();
  const updated = new Date(ownership.updatedAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(updated)) {
    return invalidPersistedSessionDataResponse('session');
  }

  return Response.json(
    projectPublicListedSession({
      kiloSessionId: ownership.kiloSessionId,
      cloudAgentSessionId: params.cloudAgentSessionId,
      userId: ownership.userId,
      organizationId: ownership.organizationId,
      title:
        (ownership.title ?? publicRepositoryTitle(ownership.repositoryUrl))?.slice(
          0,
          MAX_PUBLIC_SESSION_TITLE_CHARACTERS
        ) ?? null,
      gitUrl: ownership.repositoryUrl,
      gitBranch: null,
      profileId: null,
      createdOnPlatform: 'unknown',
      created,
      updated,
    })
  );
}

async function persistedSessionMessagesResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
  url: URL;
  query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>;
}): Promise<Response> {
  const result = await params.env.SESSION_INGEST.getCloudAgentRootSessionMessages({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
    ...params.query,
  });
  if (!result) {
    return missingRootKiloSessionResponse();
  }
  if (result.history === null) {
    return pendingSessionSnapshotResponse();
  }
  if ('kind' in result.history) {
    switch (result.history.kind) {
      case 'too_large':
        return transcriptTooLargeResponse();
      case 'retryable_failure':
        return retryableSessionReadResponse();
      case 'invalid_data':
        return invalidPersistedSessionDataResponse('messages');
    }
  }
  const publicMessages = projectPublicStoredMessages(result.history.messages, params.kiloSessionId);
  return messagesPageResponse(
    params.url,
    publicMessages,
    result.history.nextCursor,
    result.history.omittedItemCount ?? 0
  );
}

type PersistedSessionRead =
  | { kind: 'detail' }
  | {
      kind: 'messages';
      query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>;
    };

function persistedSessionReadResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
  url: URL;
  read: PersistedSessionRead;
}): Promise<Response> {
  switch (params.read.kind) {
    case 'detail':
      return persistedSessionDetailResponse(params);
    case 'messages':
      return persistedSessionMessagesResponse({ ...params, query: params.read.query });
  }
}

function parsePublicSessionDirectory(directory: string): string | null {
  const match = /^\/cloud-agent\/sessions\/([^/]+)$/.exec(directory);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function encodeSseData(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function encodeSseComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export async function defaultResolveRootSessionForKiloSession(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
}): Promise<{ cloudAgentSessionId: string } | null> {
  return params.env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
  });
}

async function eventStreamResponse(params: {
  request: Request;
  env: Env;
  userId: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
  kiloPath: string;
}): Promise<Response | null> {
  const { request, env, userId, deps, url, kiloPath } = params;
  if (kiloPath === '/global/event') {
    if (request.method !== 'GET') {
      return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
    }
    if (url.search.length > 0) {
      return facadeError(
        400,
        'KILO_EVENT_SELECTOR_UNSUPPORTED',
        'Global event selectors are not supported'
      );
    }
    const globalEvents = deps?.globalEvents;
    if (!globalEvents) {
      return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade stream is unavailable');
    }
    return globalEvents.openPublicGlobalEventStream(userId);
  }

  if (kiloPath !== '/event') {
    return null;
  }
  if (request.method !== 'GET') {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }
  if ([...url.searchParams.keys()].some(key => key !== 'directory')) {
    return facadeError(
      400,
      'KILO_EVENT_SELECTOR_UNSUPPORTED',
      'Only the Cloud Agent session directory selector is supported'
    );
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }
  const directory = url.searchParams.get('directory');
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
  if (!isSessionIngestKiloSessionId(kiloSessionId)) {
    return missingRootKiloSessionResponse();
  }
  const resolveRoot =
    deps?.resolveRootSessionForKiloSession ?? defaultResolveRootSessionForKiloSession;
  const root = await resolveRoot({ env, userId, kiloSessionId });
  if (!root) {
    return missingRootKiloSessionResponse();
  }
  if (!isControlSession(root.cloudAgentSessionId)) {
    return missingRootKiloSessionResponse();
  }
  return openHostedNativeAttachment({
    env,
    userId,
    deps,
    cloudAgentSessionId: root.cloudAgentSessionId,
    kiloSessionId,
  });
}

/**
 * Hosted native attach. The snapshot is delivered first, then the fence, then
 * pushes above it. A stopped runtime is reported as such instead of being
 * woken, and an attach that cannot prove continuity asks for a resnapshot.
 */
async function openHostedNativeAttachment(params: {
  env: Env;
  userId: string;
  deps?: KiloFacadeRequestDeps;
  cloudAgentSessionId: string;
  kiloSessionId: string;
}): Promise<Response> {
  const { env, userId, deps, cloudAgentSessionId, kiloSessionId } = params;
  const open = deps?.openNativeAttachment ?? defaultOpenNativeAttachment;
  const globalEvents = deps?.globalEvents;
  if (!globalEvents)
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade stream is unavailable');
  const attachmentId =
    globalEvents instanceof UserKiloFacade
      ? globalEvents.prepareNativeAttachment(cloudAgentSessionId, kiloSessionId, userId)
      : undefined;
  const release = () => {
    if (globalEvents instanceof UserKiloFacade && attachmentId !== undefined)
      globalEvents.releaseNativeAttachment(attachmentId);
  };
  let attach: NativeAttachOutcome;
  try {
    attach = await open({ env, userId, cloudAgentSessionId, kiloSessionId, attachmentId });
  } catch {
    release();
    return facadeError(503, 'KILO_SESSION_READ_RETRYABLE', 'Native event stream is unavailable');
  }
  if (attach.kind === 'stopped') {
    release();
    return facadeError(
      503,
      'KILO_LIVE_RUNTIME_UNAVAILABLE',
      'Cloud Agent Kilo runtime is not live'
    );
  }
  if (attach.kind === 'unavailable') {
    release();
    return facadeError(503, attach.code, attach.message);
  }
  return globalEvents.openPublicSessionEventStream(kiloSessionId, {
    ...(attach.kind === 'resnapshot' ? { resnapshot: true } : { fence: attach.fence }),
    snapshot: attach.kind === 'resnapshot' ? [] : attach.events,
    attachmentId,
    nextPage: attach.kind === 'fenced' ? attach.nextPage : undefined,
    continuity: attach.kind === 'fenced' ? attach.continuity : undefined,
  });
}

async function readOwnedKiloSession(params: {
  env: Env;
  userId: string;
  url: URL;
  kiloSessionId: string;
  cloudAgentSessionId: string;
  read: PersistedSessionRead;
}): Promise<Response> {
  if (params.read.kind === 'detail') {
    const pendingResponse = await groupedPendingSessionDetailResponse({
      env: params.env,
      userId: params.userId,
      kiloSessionId: params.kiloSessionId,
      cloudAgentSessionId: params.cloudAgentSessionId,
    });
    if (pendingResponse) return pendingResponse;
  }
  return persistedSessionReadResponse({
    env: params.env,
    userId: params.userId,
    kiloSessionId: params.kiloSessionId,
    url: params.url,
    read: params.read,
  });
}

export async function handleKiloFacadeRequest(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  const { request, env, userId, authToken, deps } = params;
  const url = new URL(request.url);
  const kiloPath = kiloRelativePath(url.pathname);

  const streamResponse = await eventStreamResponse({ request, env, userId, deps, url, kiloPath });
  if (streamResponse) {
    return streamResponse;
  }

  if (kiloPath === '/session' && request.method === 'GET') {
    const query = parseSessionListQuery(url);
    if (query instanceof Response) {
      return query;
    }
    const sessions = await env.SESSION_INGEST.listCloudAgentRootSessions({
      ...query,
      kiloUserId: userId,
    });
    return Response.json(sessions.items.map(projectPublicListedSession));
  }

  if (
    kiloPath === '/session' ||
    KNOWN_UNSUPPORTED_ROUTES.has(`${request.method} ${kiloPath}`) ||
    (kiloPath === '/session/status' && request.method !== 'GET')
  ) {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }

  const collectionNativeRoute = classifyNativeRoute(request.method, kiloPath, null);
  if (collectionNativeRoute?.kind === 'answering') {
    const session = await resolveNativeRouteSession({ env, userId, deps, url });
    if (session instanceof Response) return session;
    return answerOwnedNativeInteraction({
      request,
      env,
      userId,
      cloudAgentSessionId: session.cloudAgentSessionId,
      route: collectionNativeRoute,
    });
  }
  if (collectionNativeRoute !== null) {
    return handleCollectionNativeRoute({
      request,
      env,
      userId,
      authToken,
      deps,
      url,
      route: collectionNativeRoute,
    });
  }

  const route = parseRootSessionRoute(kiloPath);
  if (!route) {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }
  if (!isSessionIngestKiloSessionId(route.kiloSessionId)) {
    return missingRootKiloSessionResponse();
  }

  const resolveRoot =
    deps?.resolveRootSessionForKiloSession ?? defaultResolveRootSessionForKiloSession;
  const root = await resolveRoot({ env, userId, kiloSessionId: route.kiloSessionId });
  if (!root) {
    return missingRootKiloSessionResponse();
  }
  if (!isControlSession(root.cloudAgentSessionId)) {
    return missingRootKiloSessionResponse();
  }

  const sessionNativeRoute = classifyNativeRoute(
    request.method,
    kiloPath,
    route.encodedKiloSessionId
  );

  if (sessionNativeRoute?.kind === 'answering') {
    return answerOwnedNativeInteraction({
      request,
      env,
      userId,
      cloudAgentSessionId: root.cloudAgentSessionId,
      route: sessionNativeRoute,
    });
  }

  if (sessionNativeRoute !== null) {
    return handleSessionNativeRoute({
      request,
      env,
      userId,
      authToken,
      deps,
      url,
      kiloSessionId: route.kiloSessionId,
      cloudAgentSessionId: root.cloudAgentSessionId,
      route: sessionNativeRoute,
    });
  }

  const routeClassification = {
    detailRead: isExactSessionDetailRead(request.method, kiloPath, route.encodedKiloSessionId),
    messagesRead: isExactSessionMessagesRead(request.method, kiloPath, route.encodedKiloSessionId),
    promptAsync: isExactSessionPromptAsync(request.method, kiloPath, route.encodedKiloSessionId),
    abort: isExactSessionAbort(request.method, kiloPath, route.encodedKiloSessionId),
  };
  if (
    !routeClassification.detailRead &&
    !routeClassification.messagesRead &&
    !routeClassification.promptAsync &&
    !routeClassification.abort
  ) {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }
  const paginationKeys = routeClassification.messagesRead
    ? new Set(['limit', 'before'])
    : new Set<string>();
  const selectorResponse = validateIdScopedSelectors(url, route.kiloSessionId, paginationKeys);
  if (selectorResponse) return selectorResponse;

  if (routeClassification.promptAsync) {
    return handlePromptAsyncMutation({
      request,
      env,
      userId,
      authToken,
      cloudAgentSessionId: root.cloudAgentSessionId,
      deps,
    });
  }
  if (routeClassification.abort) {
    return handleAbortMutation({
      env,
      userId,
      cloudAgentSessionId: root.cloudAgentSessionId,
      deps,
    });
  }

  let persistedRead: PersistedSessionRead = { kind: 'detail' };
  if (routeClassification.messagesRead) {
    const messageQuery = parseSessionMessagesQuery(url);
    if (messageQuery instanceof Response) {
      return messageQuery;
    }
    persistedRead = { kind: 'messages', query: messageQuery };
  }
  return readOwnedKiloSession({
    env,
    userId,
    url,
    kiloSessionId: route.kiloSessionId,
    cloudAgentSessionId: root.cloudAgentSessionId,
    read: persistedRead,
  });
}

/** Binds the test seam to one session without inventing a second default. */
function nativeLiveReadSeam(
  seam: KiloFacadeRequestDeps['nativeLiveRead'],
  params: { env: Env; userId: string; cloudAgentSessionId: string }
): { read?: NativeLiveReader } {
  if (seam === undefined) return {};
  return {
    read: operation => seam({ ...params, operation }),
  };
}

function nativeReadErrorResponse(outcome: NativeReadOutcome): Response {
  if (outcome.kind === 'too_large') {
    return facadeError(413, 'KILO_TRANSCRIPT_TOO_LARGE', 'Kilo response exceeds the public budget');
  }
  if (outcome.kind === 'not_ready') {
    return facadeError(503, 'KILO_LIVE_RUNTIME_UNAVAILABLE', outcome.message);
  }
  if (outcome.kind === 'failed') {
    const status =
      outcome.code === 'KILO_LIVE_RUNTIME_UNAVAILABLE'
        ? 503
        : outcome.code === 'KILO_UPSTREAM_RESPONSE_INVALID'
          ? 502
          : 500;
    return facadeError(status, outcome.code, outcome.message);
  }
  return Response.json(outcome.body);
}

/**
 * Resolves the hosted session a non-session native route names. The public
 * directory selector is the only accepted handle, and authorization runs for
 * exactly that owner/org session, so a sibling workspace can never answer.
 */
async function resolveNativeRouteSession(params: {
  env: Env;
  userId: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
}): Promise<{ kiloSessionId: string; cloudAgentSessionId: string } | Response> {
  for (const key of params.url.searchParams.keys()) {
    if (key !== 'directory') return unsupportedSessionSelectorResponse();
  }
  if (hasDuplicateQueryParameters(params.url.searchParams)) {
    return unsupportedSessionSelectorResponse();
  }
  const directory = params.url.searchParams.get('directory');
  if (!directory) {
    return facadeError(
      400,
      'KILO_EVENT_DIRECTORY_REQUIRED',
      'A Cloud Agent session directory selector is required'
    );
  }
  const kiloSessionId = parsePublicSessionDirectory(directory);
  if (!kiloSessionId) return unsupportedSessionSelectorResponse();
  if (!isSessionIngestKiloSessionId(kiloSessionId)) return missingRootKiloSessionResponse();
  const resolveRoot =
    params.deps?.resolveRootSessionForKiloSession ?? defaultResolveRootSessionForKiloSession;
  const root = await resolveRoot({
    env: params.env,
    userId: params.userId,
    kiloSessionId,
  });
  if (!root) return missingRootKiloSessionResponse();
  if (!isControlSession(root.cloudAgentSessionId)) return missingRootKiloSessionResponse();
  return { kiloSessionId, cloudAgentSessionId: root.cloudAgentSessionId };
}

async function handleCollectionNativeRoute(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
  route: NativeSessionRoute;
}): Promise<Response> {
  const { request, env, userId, deps, route } = params;
  const session = await resolveNativeRouteSession(params);
  if (session instanceof Response) return session;

  if (route.kind === 'read') {
    const outcome = await readNativeLiveOperation({
      env,
      userId,
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
      operation: route.operation,
      ...nativeLiveReadSeam(deps?.nativeLiveRead, {
        env,
        userId,
        cloudAgentSessionId: session.cloudAgentSessionId,
      }),
    });
    return nativeReadErrorResponse(outcome);
  }
  if (route.kind === 'answering') {
    const body = await parseNativeAnswerBody(request, route);
    if (!body.ok) return facadeError(body.status, body.code, body.message);
    return answerHostedNativeInteraction({
      env,
      userId,
      cloudAgentSessionId: session.cloudAgentSessionId,
      reply: body.reply,
    });
  }
  return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
}

async function handleSessionNativeRoute(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
  kiloSessionId: string;
  cloudAgentSessionId: string;
  route: NativeSessionRoute;
}): Promise<Response> {
  const { request, env, userId, deps, url, kiloSessionId, cloudAgentSessionId, route } = params;
  const selectorResponse = validateIdScopedSelectors(url, kiloSessionId, new Set());
  if (selectorResponse) return selectorResponse;

  if (route.kind === 'read') {
    const outcome = await readNativeLiveOperation({
      env,
      userId,
      cloudAgentSessionId,
      kiloSessionId,
      operation: route.operation,
      ...nativeLiveReadSeam(deps?.nativeLiveRead, { env, userId, cloudAgentSessionId }),
    });
    return nativeReadErrorResponse(outcome);
  }
  if (request.headers.get('x-skip-balance-check') !== null) {
    return facadeError(
      400,
      'KILO_BALANCE_BYPASS_UNSUPPORTED',
      'Balance bypass is not supported for public Kilo prompt mutations'
    );
  }
  const body = await parseNativeCommandBody(request);
  if (!body.ok) return facadeError(body.status, body.code, body.message);
  return admitHostedCommand({
    env,
    userId,
    authToken: params.authToken,
    cloudAgentSessionId,
    body: body.body,
    deps,
  });
}

async function answerOwnedNativeInteraction(params: {
  request: Request;
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  route: Extract<NativeSessionRoute, { kind: 'answering' }>;
}): Promise<Response> {
  const body = await parseNativeAnswerBody(params.request, params.route);
  if (!body.ok) return facadeError(body.status, body.code, body.message);
  return answerHostedNativeInteraction({
    env: params.env,
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
    reply: body.reply,
  });
}

/**
 * Questions and permissions route through the Session DO's answer path, which
 * names the route itself and validates membership of the pending set. A stale
 * runtime id or a sibling attachment therefore cannot answer anything.
 */
async function answerHostedNativeInteraction(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  reply: Extract<NativeSessionRoute, { kind: 'answering' }>['reply'];
}): Promise<Response> {
  const payload: ControlPlaneAnswerReply =
    params.reply.action === 'question.reply'
      ? { action: 'answer', questionId: params.reply.questionId, answers: params.reply.answers }
      : params.reply.action === 'question.reject'
        ? { action: 'reject', questionId: params.reply.questionId }
        : {
            action: 'permission',
            permissionId: params.reply.permissionId,
            response: params.reply.response,
          };
  const result = await withDORetry<DurableObjectStub<SandboxSessionV2>, ControlPlaneDispatchResult>(
    () => getSandboxSessionStub(params.env, params.userId, params.cloudAgentSessionId),
    stub => stub.answer({ sessionId: params.cloudAgentSessionId, reply: payload }),
    'answer'
  );
  if (result === 'not_connected') {
    return facadeError(
      409,
      'KILO_INTERACTION_UNAVAILABLE',
      'The session does not wait on this interaction'
    );
  }
  return Response.json(true);
}

/**
 * Commands are admitted exactly like prompts: balance, model policy, durable
 * queue, and idempotency all apply, so the native facade cannot bypass Cloud's
 * controls by proxying a mutation straight to the sandbox.
 */
async function admitHostedCommand(params: {
  env: Env;
  userId: string;
  authToken?: string;
  cloudAgentSessionId: string;
  body: { messageID?: string; command: string; arguments?: string; agent?: string; model?: string };
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  if (!params.authToken) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Durable prompt admission is unavailable');
  }
  const messageId = params.body.messageID ?? createMessageId();
  const command = {
    turn: {
      type: 'command',
      id: messageId,
      command: params.body.command,
      arguments: params.body.arguments ?? '',
    },
    ...(params.body.agent === undefined && params.body.model === undefined
      ? {}
      : {
          agent: {
            ...(params.body.agent === undefined ? {} : { mode: params.body.agent }),
            ...(params.body.model === undefined ? {} : { model: params.body.model }),
          },
        }),
  } satisfies QueueExecutionTurnCommand;
  const request: SubmittedSessionMessageRequest = { userId: params.userId, ...command };
  const admitPrompt = params.deps?.admitPrompt ?? defaultAdmitPrompt;
  let admission: SessionMessageAdmissionResult;
  try {
    admission = await preflightAndAdmitPromptMessage(
      { cloudAgentSessionId: params.cloudAgentSessionId, ...command },
      { env: params.env, userId: params.userId, authToken: params.authToken },
      'kilo.command',
      () =>
        admitPrompt({
          env: params.env,
          userId: params.userId,
          cloudAgentSessionId: params.cloudAgentSessionId,
          request,
        })
    );
  } catch (error) {
    return promptPreflightError(error);
  }
  if (!admission.success) return promptAdmissionError(admission);
  return new Response(null, { status: 204 });
}

export class UserKiloFacade extends DurableObject<Env> implements KiloFacadeGlobalEvents {
  private subscribers = new Map<string, PublicSubscriber>();
  private readonly nativeSubscriberSessions = new Map<
    string,
    { cloudAgentSessionId: string; kiloSessionId: string; userId: string }
  >();
  private readonly nativeWriters = new Map<
    string,
    { waiting?: () => void; attachmentId: string }
  >();
  private readonly nativeUnsubscribes = new Map<string, () => void>();
  private readonly globalNativeAttachments = new Map<string, Map<string, string>>();
  private readonly globalNativeRefreshes = new Map<string, Promise<void>>();
  private readonly nativeRefreshes = new Map<string, Promise<void>>();
  private readonly nativeProbeFailures = new Map<string, number>();
  private readonly nativeAttachments = createNativeAttachmentRegistry(
    (attachmentId, kiloSessionId) => {
      for (const [subscriberId, attachments] of this.globalNativeAttachments) {
        if (![...attachments.values()].includes(attachmentId)) continue;
        this.sendToSubscriber(subscriberId, {
          directory: publicCloudAgentDirectory(kiloSessionId),
          payload: {
            type: NATIVE_FACADE_RESNAPSHOT_EVENT,
            properties: { sessionID: kiloSessionId, reason: 'continuity_unproven' },
          },
        });
        for (const [sessionId, id] of attachments) {
          if (id === attachmentId) attachments.delete(sessionId);
        }
        this.nativeUnsubscribes.get(attachmentId)?.();
        this.nativeUnsubscribes.delete(attachmentId);
        this.releaseNativeAttachment(attachmentId);
      }
      for (const [subscriberId, writer] of this.nativeWriters) {
        if (writer.attachmentId !== attachmentId) continue;
        this.sendToSubscriber(subscriberId, {
          type: NATIVE_FACADE_RESNAPSHOT_EVENT,
          properties: {
            sessionID: kiloSessionId,
            directory: publicCloudAgentDirectory(kiloSessionId),
            reason: 'continuity_unproven',
          },
        });
        const subscriber = this.subscribers.get(subscriberId);
        if (subscriber !== undefined) {
          subscriber.controller.close();
          this.removeSubscriber(subscriberId);
        }
      }
    }
  );

  /**
   * Session DO -> facade native event push (spec §10). Only the owning
   * session's events are accepted: the delivery names both identities and the
   * facade re-checks the root mapping before fanning out.
   */
  async publishNativeEventBatch(input: NativeEventBatch & { deadlineAt: number }): Promise<void> {
    if (Date.now() >= input.deadlineAt) throw new Error('Native event delivery deadline exceeded');
    if (
      (input.kind === 'events' ? input.events.length : input.attachmentIds.length) >
        NATIVE_DELIVERY_LIMITS.count ||
      encoder.encode(JSON.stringify(input)).byteLength > NATIVE_DELIVERY_LIMITS.batchBytes ||
      (input.kind === 'events' &&
        input.events.some(
          ({ event }) =>
            encoder.encode(JSON.stringify(event)).byteLength > NATIVE_DELIVERY_LIMITS.eventBytes
        ))
    )
      throw new Error('Native event batch exceeds delivery bounds');
    const resolved = await this.env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession({
      kiloUserId: input.kiloUserId,
      kiloSessionId: input.kiloSessionId,
    });
    if (resolved?.cloudAgentSessionId !== input.cloudAgentSessionId) {
      for (const [attachmentId, attachment] of this.nativeSubscriberSessions) {
        if (
          attachment.userId === input.kiloUserId &&
          attachment.cloudAgentSessionId === input.cloudAgentSessionId &&
          attachment.kiloSessionId === input.kiloSessionId
        )
          this.nativeAttachments.invalidate(attachmentId);
      }
      return;
    }
    if (Date.now() >= input.deadlineAt) throw new Error('Native event delivery deadline exceeded');
    const attachmentIds = [...this.nativeSubscriberSessions]
      .filter(
        ([, attachment]) =>
          attachment.userId === input.kiloUserId &&
          attachment.cloudAgentSessionId === input.cloudAgentSessionId &&
          attachment.kiloSessionId === input.kiloSessionId
      )
      .map(([id]) => id);
    if (
      input.kind === 'events' &&
      input.events.some(
        ({ event }) =>
          event.properties.sessionID !== undefined &&
          event.properties.sessionID !== input.kiloSessionId
      )
    )
      throw new Error('Native event session identity mismatch');
    this.nativeAttachments.deliverBatch(input, attachmentIds);
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(KILO_FACADE_USER_ID_HEADER);
    if (!userId) {
      return facadeError(401, 'UNAUTHENTICATED', 'Missing authenticated user context');
    }
    const authToken = request.headers.get(KILO_FACADE_AUTH_TOKEN_HEADER) ?? undefined;

    return handleKiloFacadeRequest({
      request,
      env: this.env,
      userId,
      authToken,
      deps: { globalEvents: this },
    });
  }

  openPublicGlobalEventStream(userId?: string): Response {
    return this.openPublicEventStream({ kind: 'global' }, undefined, userId);
  }

  openPublicSessionEventStream(
    kiloSessionId: string,
    native?: {
      fence?: number | null;
      resnapshot?: boolean;
      snapshot?: NativePublicEvent[];
      attachmentId?: string;
      nextPage?: () => Promise<NativeAttachOutcome>;
      continuity?: NativeEventContinuity;
    }
  ): Response {
    return this.openPublicEventStream(
      { kind: 'session', kiloSessionId },
      native === undefined ? undefined : { kind: 'native', ...native }
    );
  }

  /** Registers the hosted attach a following `openPublicSessionEventStream` joins. */
  prepareNativeAttachment(
    cloudAgentSessionId: string,
    kiloSessionId: string,
    userId: string
  ): string {
    const attachmentId = crypto.randomUUID();
    this.nativeSubscriberSessions.set(attachmentId, { cloudAgentSessionId, kiloSessionId, userId });
    this.nativeAttachments.begin(cloudAgentSessionId, kiloSessionId, attachmentId);
    return attachmentId;
  }

  releaseNativeAttachment(attachmentId: string): void {
    const attachment = this.nativeSubscriberSessions.get(attachmentId);
    if (attachment === undefined) return;
    this.nativeSubscriberSessions.delete(attachmentId);
    this.nativeProbeFailures.delete(attachmentId);
    this.nativeAttachments.release(attachmentId);
    this.ctx.waitUntil(
      withDORetry(
        () => getSandboxSessionStub(this.env, attachment.userId, attachment.cloudAgentSessionId),
        stub => stub.releaseNativeEvents({ attachmentId }),
        'releaseNativeEvents'
      ).catch(error =>
        logger.withFields({ error: String(error) }).error('Failed to release native events')
      )
    );
  }

  async publishCloudAgentExtensionEvent(input: {
    kiloUserId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    organizationId?: string;
    event: PublicCloudAgentExtensionEvent;
  }): Promise<void> {
    if (input.organizationId) {
      const sessionIngest = this.env.SESSION_INGEST;
      if (!sessionIngest) return;
      const resolved = await sessionIngest.resolveCloudAgentRootSessionForKiloSession({
        kiloUserId: input.kiloUserId,
        kiloSessionId: input.kiloSessionId,
      });
      if (resolved?.cloudAgentSessionId !== input.cloudAgentSessionId) return;
    }
    this.broadcastGlobalEvent(
      { directory: publicCloudAgentDirectory(input.kiloSessionId), payload: input.event },
      input.kiloSessionId
    );
  }

  private openPublicEventStream(
    scope: PublicSubscriber['scope'],
    native?: {
      kind: 'native';
      fence?: number | null;
      resnapshot?: boolean;
      snapshot?: NativePublicEvent[];
      attachmentId?: string;
      nextPage?: () => Promise<NativeAttachOutcome>;
      continuity?: NativeEventContinuity;
    },
    globalUserId?: string
  ): Response {
    const subscriberId = crypto.randomUUID();
    const publicConnectionEvent = () =>
      scope.kind === 'global'
        ? {
            directory: PUBLIC_VIRTUAL_SERVER_DIRECTORY,
            payload: createPublicEventPayload('server.connected'),
          }
        : createPublicEventPayload('server.connected');

    const stream = new ReadableStream<Uint8Array>(
      {
        start: controller => {
          const subscriber: PublicSubscriber = {
            controller,
            scope,
            heartbeat: setInterval(() => {
              if (globalUserId !== undefined) {
                this.ctx.waitUntil(this.refreshGlobalNativeAttachments(subscriberId, globalUserId));
              }
              for (const attachmentId of this.globalNativeAttachments.get(subscriberId)?.values() ??
                [])
                this.ctx.waitUntil(this.refreshNativeAttachment(attachmentId));
              const attachmentId = this.nativeWriters.get(subscriberId)?.attachmentId;
              if (attachmentId !== undefined)
                this.ctx.waitUntil(this.refreshNativeAttachment(attachmentId));
              if (this.nativeWriters.get(subscriberId)?.waiting !== undefined) return;
              this.sendCommentToSubscriber(subscriberId, 'heartbeat');
            }, HEARTBEAT_INTERVAL_MS),
          };
          this.subscribers.set(subscriberId, subscriber);
          if (globalUserId === undefined) {
            this.sendToSubscriber(subscriberId, publicConnectionEvent());
          } else {
            this.ctx.waitUntil(
              this.refreshGlobalNativeAttachments(subscriberId, globalUserId).then(() => {
                this.sendToSubscriber(subscriberId, publicConnectionEvent());
              })
            );
          }
          if (native !== undefined && scope.kind === 'session') {
            this.ctx.waitUntil(
              this.openNativeSessionAttachment(subscriberId, scope.kiloSessionId, native)
            );
          }
        },
        cancel: () => {
          this.removeSubscriber(subscriberId);
        },
        pull: () => {
          this.nativeWriters.get(subscriberId)?.waiting?.();
        },
      },
      { highWaterMark: MAX_PUBLIC_GLOBAL_EVENT_QUEUE_SIZE, size: () => 1 }
    );

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  /**
   * Starts a hosted session's fenced native attach for one SSE subscriber. The
   * snapshot through the fence respects SSE backpressure, pushes above
   * the fence follow, and the registry marks the fence complete so buffered
   * pushes drain in order.
   */
  private async openNativeSessionAttachment(
    subscriberId: string,
    kiloSessionId: string,
    native: {
      fence?: number | null;
      resnapshot?: boolean;
      snapshot?: NativePublicEvent[];
      attachmentId?: string;
      nextPage?: () => Promise<NativeAttachOutcome>;
      continuity?: NativeEventContinuity;
    }
  ): Promise<void> {
    const directory = publicCloudAgentDirectory(kiloSessionId);
    const attachmentId = native.attachmentId;
    if (attachmentId === undefined) return;
    const writer = { attachmentId, waiting: undefined as (() => void) | undefined };
    this.nativeWriters.set(subscriberId, writer);
    if (native.continuity !== undefined)
      this.nativeAttachments.bind(attachmentId, native.continuity);
    if (this.nativeWriters.get(subscriberId) !== writer) return;
    const send = async (event: NativePublicEvent) => {
      while (
        this.subscribers.has(subscriberId) &&
        this.nativeWriters.get(subscriberId) === writer &&
        (this.subscribers.get(subscriberId)?.controller.desiredSize ?? 0) <= 0
      ) {
        await new Promise<void>(resolve => {
          writer.waiting = resolve;
        });
        writer.waiting = undefined;
      }
      if (
        (this.nativeAttachments.isLost(attachmentId) ||
          this.nativeWriters.get(subscriberId) !== writer) &&
        event.type !== NATIVE_FACADE_RESNAPSHOT_EVENT
      )
        return;
      this.sendToSubscriber(subscriberId, event);
    };
    try {
      if (native.resnapshot === true) {
        await send({
          type: NATIVE_FACADE_RESNAPSHOT_EVENT,
          properties: { sessionID: kiloSessionId, directory, reason: 'snapshot_too_large' },
        });
        this.clearNativeSubscriber(subscriberId);
        return;
      }
      let tail = Promise.resolve();
      let queued = 0;
      let queuedBytes = 0;
      const unsubscribe = this.nativeAttachments.subscribe(attachmentId, event => {
        const bytes = encoder.encode(JSON.stringify(event)).byteLength;
        if (!canRetainNativeEvent(queued, queuedBytes, bytes)) {
          this.subscribers.get(subscriberId)?.controller.error(new Error(SLOW_SUBSCRIBER_ERROR));
          this.removeSubscriber(subscriberId);
          return;
        }
        queued++;
        queuedBytes += bytes;
        tail = tail
          .then(() =>
            (this.nativeAttachments.isLost(attachmentId) ||
              this.nativeWriters.get(subscriberId) !== writer) &&
            event.type !== NATIVE_FACADE_RESNAPSHOT_EVENT
              ? undefined
              : send(event)
          )
          .then(() => {
            queued--;
            queuedBytes -= bytes;
          })
          .catch(error => {
            this.subscribers.get(subscriberId)?.controller.error(error);
            this.removeSubscriber(subscriberId);
          });
        this.ctx.waitUntil(tail);
      });
      if (this.nativeWriters.get(subscriberId) !== writer) {
        unsubscribe();
        this.clearNativeSubscriber(subscriberId);
        return;
      }
      this.nativeUnsubscribes.set(subscriberId, unsubscribe);
      let events = native.snapshot ?? [];
      let nextPage = native.nextPage;
      for (;;) {
        for (const event of events) {
          if (
            this.nativeAttachments.isLost(attachmentId) ||
            this.nativeWriters.get(subscriberId) !== writer
          ) {
            this.clearNativeSubscriber(subscriberId);
            return;
          }
          await send(event);
          if (!this.subscribers.has(subscriberId)) return;
        }
        if (nextPage === undefined) break;
        const page = await nextPage();
        if (page.kind !== 'fenced') {
          await send({
            type: NATIVE_FACADE_RESNAPSHOT_EVENT,
            properties: { sessionID: kiloSessionId, directory, reason: 'snapshot_unavailable' },
          });
          this.clearNativeSubscriber(subscriberId);
          return;
        }
        events = page.events;
        nextPage = page.nextPage;
      }
      if (
        this.nativeAttachments.isLost(attachmentId) ||
        this.nativeWriters.get(subscriberId) !== writer
      ) {
        this.clearNativeSubscriber(subscriberId);
        return;
      }
      await send({
        type: NATIVE_FACADE_FENCE_EVENT,
        properties: {
          sessionID: kiloSessionId,
          directory,
          ...(native.fence === undefined || native.fence === null ? {} : { fence: native.fence }),
          snapshotComplete: true,
        },
      });
      this.nativeAttachments.complete(attachmentId, native.fence ?? null);
    } catch (error) {
      this.subscribers.get(subscriberId)?.controller.error(error);
      this.removeSubscriber(subscriberId);
    }
  }

  private sendFrameToSubscriber(subscriberId: string, frame: Uint8Array): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) return;
    if (subscriber.controller.desiredSize !== null && subscriber.controller.desiredSize <= 0) {
      this.removeSubscriber(subscriberId);
      subscriber.controller.error(new Error(SLOW_SUBSCRIBER_ERROR));
      return;
    }
    try {
      subscriber.controller.enqueue(frame);
    } catch {
      this.removeSubscriber(subscriberId);
    }
  }

  private sendToSubscriber(subscriberId: string, event: unknown): void {
    this.sendFrameToSubscriber(subscriberId, encodeSseData(event));
  }

  private sendCommentToSubscriber(subscriberId: string, comment: string): void {
    this.sendFrameToSubscriber(subscriberId, encodeSseComment(comment));
  }

  private broadcastGlobalEvent(event: KiloGlobalEventEnvelope, kiloSessionId: string): void {
    for (const [subscriberId, subscriber] of this.subscribers.entries()) {
      if (subscriber.scope.kind === 'global') {
        this.sendToSubscriber(subscriberId, event);
        continue;
      }
      if (subscriber.scope.kiloSessionId === kiloSessionId && event.payload) {
        this.sendToSubscriber(subscriberId, event.payload);
      }
    }
  }

  private removeSubscriber(subscriberId: string): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) return;
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(subscriberId);
    this.clearNativeSubscriber(subscriberId);
    const attachments = this.globalNativeAttachments.get(subscriberId);
    this.globalNativeAttachments.delete(subscriberId);
    for (const attachmentId of attachments?.values() ?? []) {
      this.nativeUnsubscribes.get(attachmentId)?.();
      this.nativeUnsubscribes.delete(attachmentId);
      this.releaseNativeAttachment(attachmentId);
    }
  }

  private refreshGlobalNativeAttachments(subscriberId: string, userId: string): Promise<void> {
    const pending = this.globalNativeRefreshes.get(subscriberId);
    if (pending !== undefined) return pending;
    const refresh = this.subscribeGlobalNativeAttachments(subscriberId, userId)
      .catch(error => {
        logger
          .withFields({ error: String(error) })
          .error('Failed to subscribe global native events');
        this.sendToSubscriber(subscriberId, {
          directory: PUBLIC_VIRTUAL_SERVER_DIRECTORY,
          payload: {
            type: NATIVE_FACADE_RESNAPSHOT_EVENT,
            properties: { reason: 'subscription_unavailable' },
          },
        });
      })
      .finally(() => this.globalNativeRefreshes.delete(subscriberId));
    this.globalNativeRefreshes.set(subscriberId, refresh);
    return refresh;
  }

  private async subscribeGlobalNativeAttachments(
    subscriberId: string,
    userId: string
  ): Promise<void> {
    if (!this.subscribers.has(subscriberId)) return;
    const sessionIngest = this.env.SESSION_INGEST;
    if (!sessionIngest) return;
    const { items: roots } = await sessionIngest.listCloudAgentRootSessions({
      kiloUserId: userId,
      limit: 100,
    });
    if (!this.subscribers.has(subscriberId)) return;
    let attachments = this.globalNativeAttachments.get(subscriberId);
    if (attachments === undefined) {
      attachments = new Map();
      this.globalNativeAttachments.set(subscriberId, attachments);
    }
    const authorized = new Set(roots.map(root => root.kiloSessionId));
    for (const [kiloSessionId, attachmentId] of attachments) {
      if (authorized.has(kiloSessionId)) continue;
      attachments.delete(kiloSessionId);
      this.nativeUnsubscribes.get(attachmentId)?.();
      this.nativeUnsubscribes.delete(attachmentId);
      this.releaseNativeAttachment(attachmentId);
    }
    for (const root of roots) {
      if (!isControlSession(root.cloudAgentSessionId) || attachments.has(root.kiloSessionId))
        continue;
      if (!this.subscribers.has(subscriberId)) return;
      const attachmentId = this.prepareNativeAttachment(
        root.cloudAgentSessionId,
        root.kiloSessionId,
        userId
      );
      attachments.set(root.kiloSessionId, attachmentId);
      this.nativeUnsubscribes.set(
        attachmentId,
        this.nativeAttachments.subscribe(attachmentId, event => {
          this.sendToSubscriber(subscriberId, {
            directory: publicCloudAgentDirectory(root.kiloSessionId),
            payload: event,
          });
        })
      );
      try {
        const subscription = await withDORetry(
          () => getSandboxSessionStub(this.env, userId, root.cloudAgentSessionId),
          stub => stub.subscribeNativeEvents({ kiloSessionId: root.kiloSessionId, attachmentId }),
          'subscribeNativeEvents'
        );
        if (subscription.registered && this.subscribers.has(subscriberId)) {
          this.nativeAttachments.bind(attachmentId, subscription.continuity);
          this.nativeAttachments.complete(attachmentId, subscription.fence);
          continue;
        }
      } catch (error) {
        logger.withFields({ error: String(error) }).error('Failed to attach global native session');
      }
      attachments.delete(root.kiloSessionId);
      this.nativeUnsubscribes.get(attachmentId)?.();
      this.nativeUnsubscribes.delete(attachmentId);
      this.releaseNativeAttachment(attachmentId);
      if (!this.subscribers.has(subscriberId)) {
        this.ctx.waitUntil(
          withDORetry(
            () => getSandboxSessionStub(this.env, userId, root.cloudAgentSessionId),
            stub => stub.releaseNativeEvents({ attachmentId }),
            'releaseNativeEvents'
          ).catch(error =>
            logger.withFields({ error: String(error) }).error('Failed to release native events')
          )
        );
      }
    }
  }

  private clearNativeSubscriber(subscriberId: string): void {
    const unsubscribe = this.nativeUnsubscribes.get(subscriberId);
    this.nativeUnsubscribes.delete(subscriberId);
    unsubscribe?.();
    const writer = this.nativeWriters.get(subscriberId);
    this.nativeWriters.delete(subscriberId);
    writer?.waiting?.();
    if (writer !== undefined) this.releaseNativeAttachment(writer.attachmentId);
  }

  private refreshNativeAttachment(attachmentId: string): Promise<void> {
    const pending = this.nativeRefreshes.get(attachmentId);
    if (pending !== undefined) return pending;
    const attachment = this.nativeSubscriberSessions.get(attachmentId);
    const generation = this.nativeAttachments.generation(attachmentId);
    if (
      attachment === undefined ||
      generation === undefined ||
      this.nativeAttachments.isLost(attachmentId)
    )
      return Promise.resolve();
    const refresh = withDORetry(
      () => getSandboxSessionStub(this.env, attachment.userId, attachment.cloudAgentSessionId),
      stub =>
        stub.refreshNativeEvents({
          kiloSessionId: attachment.kiloSessionId,
          attachmentId,
          generation,
        }),
      'refreshNativeEvents',
      {
        ...DEFAULT_DO_RETRY_CONFIG,
        scope: { deadlineAt: Date.now() + NATIVE_DELIVERY_LIMITS.ageMs },
      }
    )
      .then(continuous => {
        this.nativeProbeFailures.delete(attachmentId);
        if (!continuous) this.nativeAttachments.invalidate(attachmentId);
      })
      .catch(error => {
        logger.withFields({ error: String(error) }).warn('Native attachment refresh failed');
        if (this.nativeSubscriberSessions.get(attachmentId) !== attachment) return;
        const failures = (this.nativeProbeFailures.get(attachmentId) ?? 0) + 1;
        this.nativeProbeFailures.set(attachmentId, failures);
        if (failures >= 3) this.nativeAttachments.invalidate(attachmentId);
      })
      .finally(() => this.nativeRefreshes.delete(attachmentId));
    this.nativeRefreshes.set(attachmentId, refresh);
    return refresh;
  }
}
