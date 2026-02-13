import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { appRouter } from './router.js';
import { authenticate, validateStreamTicket } from './auth.js';
import type { Env } from './types.js';
import { logger, withLogTags } from './logger.js';
import {
  validateAuthAndBalance,
  extractProcedureName,
  extractOrgIdFromUrl,
  extractSessionIdFromUrl,
  fetchOrgIdForSession,
  BALANCE_REQUIRED_SUBSCRIPTIONS,
  BALANCE_REQUIRED_MUTATIONS,
} from './balance-validation.js';
import { validateKiloToken } from './auth.js';
import { createQueueConsumer } from './queue/consumer.js';
import { createCallbackQueueConsumer } from './callbacks/index.js';
import type { ExecutionMessage } from './queue/types.js';
import type { CallbackJob } from './callbacks/index.js';

/** Auth context for creating tRPC context */
type AuthContext = {
  userId: string;
  token: string;
  botId?: string;
};

export default class KilocodeWorker extends WorkerEntrypoint<Env> {
  /**
   * Handles tRPC requests with the given auth context.
   * Centralizes fetchRequestHandler configuration to avoid duplication.
   */
  private handleTrpcRequest(request: Request, auth: AuthContext): Promise<Response> {
    return fetchRequestHandler({
      endpoint: '/trpc',
      req: request,
      router: appRouter,
      createContext: async () => ({
        env: this.env,
        userId: auth.userId,
        authToken: auth.token,
        botId: auth.botId,
        request,
      }),
      onError: ({ error, path }) => {
        logger.setTags({ path });
        logger
          .withFields({
            error: error.message,
            stack: error.stack,
          })
          .error('tRPC error');
      },
    });
  }

  private buildTrpcErrorResponse(status: number, message: string, path?: string): Response {
    const code = (() => {
      switch (status) {
        case 400:
          return 'BAD_REQUEST';
        case 401:
          return 'UNAUTHORIZED';
        case 402:
          return 'PAYMENT_REQUIRED';
        case 403:
          return 'FORBIDDEN';
        case 404:
          return 'NOT_FOUND';
        default:
          return 'INTERNAL_SERVER_ERROR';
      }
    })();

    return new Response(
      JSON.stringify({
        error: {
          message,
          code: TRPC_ERROR_CODES_BY_KEY[code],
          data: {
            code,
            httpStatus: status,
            path,
          },
        },
      }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    return withLogTags({ source: 'worker-entry' }, async () => {
      const url = new URL(request.url);
      logger.setTags({
        method: request.method,
        path: url.pathname, // Only log the path, not query params
      });
      logger.info('Handling request');

      // Handle /stream WebSocket endpoint (before tRPC handling)
      if (url.pathname === '/stream') {
        // 1. Check WebSocket upgrade header
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }

        // 2. Extract cloudAgentSessionId from query params
        const cloudAgentSessionId = url.searchParams.get('cloudAgentSessionId');
        if (!cloudAgentSessionId) {
          logger.warn('/stream: Missing cloudAgentSessionId parameter');
          return new Response('Missing cloudAgentSessionId parameter', { status: 400 });
        }

        // 3. Validate ticket from URL (browser WebSocket can't send Authorization headers)
        const ticket = url.searchParams.get('ticket');
        if (!ticket) {
          logger.withFields({ cloudAgentSessionId }).warn('/stream: Missing ticket');
          return new Response('Missing ticket', { status: 401 });
        }

        const ticketResult = validateStreamTicket(ticket, this.env.NEXTAUTH_SECRET);
        if (!ticketResult.success) {
          logger
            .withFields({ cloudAgentSessionId, error: ticketResult.error })
            .warn('/stream: Ticket validation failed');
          return new Response(ticketResult.error, { status: 401 });
        }

        const userId = ticketResult.payload.userId;
        if (!userId) {
          logger
            .withFields({ cloudAgentSessionId })
            .warn('/stream: Invalid ticket - missing userId');
          return new Response('Invalid ticket: missing userId', { status: 401 });
        }

        // 4. Verify ticket cloudAgentSessionId matches URL cloudAgentSessionId
        const ticketCloudAgentSessionId =
          ticketResult.payload.cloudAgentSessionId || ticketResult.payload.sessionId;
        if (ticketCloudAgentSessionId !== cloudAgentSessionId) {
          logger
            .withFields({ cloudAgentSessionId, ticketCloudAgentSessionId })
            .warn('/stream: Session mismatch between URL and ticket');
          return new Response('Session mismatch', { status: 403 });
        }

        logger
          .withFields({ cloudAgentSessionId, userId })
          .info('/stream: WebSocket upgrade authorized');

        // 5. Get DO stub and proxy the WebSocket upgrade (preserving all query params for filters)
        const doId = this.env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${cloudAgentSessionId}`);
        const stub = this.env.CLOUD_AGENT_SESSION.get(doId);

        return stub.fetch(request);
      }

      const ingestMatch = url.pathname.match(/^\/sessions\/([^/]+)\/([^/]+)\/ingest$/);
      if (ingestMatch) {
        // Decode userId to handle OAuth IDs like "oauth/google:123" that were URL-encoded
        let userId: string;
        try {
          userId = decodeURIComponent(ingestMatch[1]);
        } catch {
          return new Response('Invalid userId encoding', { status: 400 });
        }
        const sessionId = ingestMatch[2];
        const authHeader = request.headers.get('Authorization');
        const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
        if (!authResult.success) {
          return new Response(authResult.error, { status: 401 });
        }
        if (authResult.userId !== userId) {
          return new Response('Token does not match session user', { status: 403 });
        }
        const doId = this.env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
        const stub = this.env.CLOUD_AGENT_SESSION.get(doId);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/ingest';
        const doRequest = new Request(doUrl.toString(), request);
        return stub.fetch(doRequest);
      }

      const logsMatch = url.pathname.match(
        /^\/sessions\/([^/]+)\/([^/]+)\/logs\/([^/]+)\/([^/]+)$/
      );
      if (logsMatch && request.method === 'PUT') {
        const allowedFilenames = new Set(['cli.txt', 'wrapper.log']);
        let userId: string, sessionId: string, executionId: string, filename: string;
        try {
          userId = decodeURIComponent(logsMatch[1]);
          sessionId = decodeURIComponent(logsMatch[2]);
          executionId = decodeURIComponent(logsMatch[3]);
          filename = decodeURIComponent(logsMatch[4]);
        } catch {
          return new Response('Invalid URL encoding', { status: 400 });
        }
        if (!allowedFilenames.has(filename)) {
          return new Response('Invalid filename', { status: 400 });
        }
        const authHeader = request.headers.get('Authorization');
        const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
        if (!authResult.success) {
          return new Response(authResult.error, { status: 401 });
        }
        if (authResult.userId !== userId) {
          return new Response('Token does not match session user', { status: 403 });
        }
        if (!request.body) {
          return new Response('Missing request body', { status: 400 });
        }
        await this.env.R2_BUCKET.put(
          `logs/${userId}/${sessionId}/${executionId}/${filename}`,
          request.body
        );
        return new Response(null, { status: 204 });
      }

      // Extract procedure name for pre-flight validation
      const procedureName = extractProcedureName(url.pathname);

      // Pre-flight validation for subscription endpoints that require balance
      // This ensures we return proper HTTP status codes (401, 402) before opening SSE stream
      if (procedureName && BALANCE_REQUIRED_SUBSCRIPTIONS.has(procedureName)) {
        // Check for balance skip header (used by App Builder which handles its own billing)
        const skipBalanceCheck = request.headers.get('x-skip-balance-check') === 'true';

        const authHeader = request.headers.get('authorization');

        // If skipping balance check, only validate auth (not balance)
        if (skipBalanceCheck) {
          logger.withFields({ procedure: procedureName }).info('Skipping balance check per header');

          const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
          if (!authResult.success) {
            return new Response(JSON.stringify({ error: authResult.error }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          return this.handleTrpcRequest(request, authResult);
        }

        // For sendMessageStream, we need to fetch orgId from session metadata
        // since it only has sessionId in input (not kilocodeOrganizationId)
        let orgId: string | undefined;
        if (procedureName === 'sendMessageStream') {
          let sessionId: string | undefined;
          try {
            sessionId = extractSessionIdFromUrl(url);
          } catch (_error) {
            return new Response(JSON.stringify({ error: 'Invalid tRPC input format' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (!sessionId) {
            logger
              .withFields({ procedure: procedureName })
              .warn('Missing sessionId for sendMessageStream');
            return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // First validate auth to get userId for DO lookup
          const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
          if (!authResult.success) {
            return new Response(JSON.stringify({ error: authResult.error }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          orgId = await fetchOrgIdForSession(this.env, authResult.userId, sessionId);
        } else {
          try {
            orgId = extractOrgIdFromUrl(url);
          } catch (_error) {
            return this.buildTrpcErrorResponse(400, 'Invalid tRPC input format', procedureName);
          }
        }

        const validationResult = await validateAuthAndBalance(authHeader, orgId, this.env);

        if (!validationResult.success) {
          logger
            .withFields({
              status: validationResult.status,
              procedure: procedureName,
            })
            .warn('Pre-flight validation failed');

          return this.buildTrpcErrorResponse(
            validationResult.status,
            validationResult.message,
            procedureName
          );
        }

        return this.handleTrpcRequest(request, validationResult);
      }

      // Pre-flight validation for V2 mutation endpoints that require balance
      // These are POST requests with JSON body containing the input
      if (procedureName && BALANCE_REQUIRED_MUTATIONS.has(procedureName)) {
        // Check for balance skip header (used by App Builder which handles its own billing)
        const skipBalanceCheck = request.headers.get('x-skip-balance-check') === 'true';

        const authHeader = request.headers.get('authorization');

        // If skipping balance check, only validate auth (not balance)
        if (skipBalanceCheck) {
          logger.withFields({ procedure: procedureName }).info('Skipping balance check per header');

          const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
          if (!authResult.success) {
            return this.buildTrpcErrorResponse(401, authResult.error, procedureName);
          }

          return this.handleTrpcRequest(request, authResult);
        }

        // Clone request to read body without consuming it
        const clonedRequest = request.clone();
        let orgId: string | undefined;
        let sessionId: string | undefined;

        try {
          const body = await clonedRequest.json();
          // tRPC mutations have input at the root level
          if (body && typeof body === 'object') {
            if (
              'kilocodeOrganizationId' in body &&
              typeof body.kilocodeOrganizationId === 'string'
            ) {
              orgId = body.kilocodeOrganizationId;
            }
            if ('cloudAgentSessionId' in body && typeof body.cloudAgentSessionId === 'string') {
              sessionId = body.cloudAgentSessionId;
            }
          }
        } catch {
          return this.buildTrpcErrorResponse(400, 'Invalid request body', procedureName);
        }

        // For sendMessageV2, we need to fetch orgId from session metadata if not in input
        if (procedureName === 'sendMessageV2' && !orgId && sessionId) {
          const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
          if (!authResult.success) {
            return this.buildTrpcErrorResponse(401, authResult.error, procedureName);
          }
          orgId = await fetchOrgIdForSession(this.env, authResult.userId, sessionId);
        }

        // For initiateFromKilocodeSessionV2, fetch from session metadata
        if (procedureName === 'initiateFromKilocodeSessionV2' && !orgId && sessionId) {
          const authResult = validateKiloToken(authHeader, this.env.NEXTAUTH_SECRET);
          if (!authResult.success) {
            return this.buildTrpcErrorResponse(401, authResult.error, procedureName);
          }
          orgId = await fetchOrgIdForSession(this.env, authResult.userId, sessionId);
        }

        const validationResult = await validateAuthAndBalance(authHeader, orgId, this.env);

        if (!validationResult.success) {
          logger
            .withFields({
              status: validationResult.status,
              procedure: procedureName,
            })
            .warn('Pre-flight validation failed for V2 mutation');

          return this.buildTrpcErrorResponse(
            validationResult.status,
            validationResult.message,
            procedureName
          );
        }

        return this.handleTrpcRequest(request, validationResult);
      }

      // For non-balance-required endpoints, use standard tRPC handling
      const authResult = authenticate(request, this.env);
      return this.handleTrpcRequest(request, authResult);
    });
  }

  /**
   * Handles queue messages for execution and callback processing.
   * Dispatches to the appropriate consumer based on queue name.
   */
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    // Check if this is a callback queue (prod: cloud-agent-callback-queue, dev: cloud-agent-callback-queue-dev)
    if (batch.queue.startsWith('cloud-agent-callback-queue')) {
      const consumer = createCallbackQueueConsumer();
      return consumer(batch as MessageBatch<CallbackJob>);
    }

    // Default to existing execution queue behavior
    const consumer = createQueueConsumer();
    return consumer(batch as MessageBatch<ExecutionMessage>, this.env, this.ctx);
  }
}

export { Sandbox } from '@cloudflare/sandbox';
export { CloudAgentSession } from './persistence/CloudAgentSession';
