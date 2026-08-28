import { z } from 'zod';
import { withDeadline, CONTROL_PLANE_DEADLINE_MS, SEND_DEADLINE_MS } from '@kilocode/event-service';
import { KiloChatApiError } from './errors';
import {
  conversationListResponseSchema,
  conversationDetailResponseSchema,
  createConversationResponseSchema,
  createMessageResponseSchema,
  editMessageResponseSchema,
  markConversationReadResponseSchema,
  messageListResponseSchema,
  addReactionResponseSchema,
  removeReactionResponseSchema,
  okResponseSchema,
  executeActionResponseSchema,
  getBotStatusResponseSchema,
  requestBotStatusResponseSchema,
  getConversationStatusResponseSchema,
  attachmentInitResponseSchema,
  attachmentGetUrlResponseSchema,
  type listConversationsQuerySchema,
  type listMessagesQuerySchema,
  type deleteMessageQuerySchema,
  type reactionRequestBodySchema,
  type executeActionRequestSchema,
} from './schemas';
import {
  getKiloChatEventPayloadSchema,
  type KiloChatEventName,
  type KiloChatEventOf,
} from './events';
import type {
  KiloChatClientConfig,
  KiloChatOperation,
  ConversationListResponse,
  MessageListResponse,
  ConversationDetailResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  EditMessageRequest,
  EditMessageResponse,
  RenameConversationRequest,
  MarkConversationReadRequest,
  MarkConversationReadResponse,
  Message,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  MessageRedeliveredEvent,
  ActionDeliveryFailedEvent,
  TypingEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  AddReactionResponse,
  RemoveReactionResponse,
  ExecuteActionResponse,
  ConversationCreatedEvent,
  ConversationRenamedEvent,
  ConversationLeftEvent,
  ConversationReadEvent,
  ConversationActivityEvent,
  BotStatusEvent,
  ConversationStatusEvent,
  GetBotStatusResponse,
  GetConversationStatusResponse,
  RequestBotStatusResponse,
  AttachmentInitRequest,
  AttachmentInitResponse,
  AttachmentGetUrlRequest,
  AttachmentGetUrlResponse,
} from './types';

// Accept any response body for fire-and-forget endpoints. The server may
// return `{}` (200) or no body (204); the client doesn't inspect either.
const voidSchema = z.unknown();

export class KiloChatClient {
  private readonly es: KiloChatClientConfig['eventService'];
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly onUnauthorized: KiloChatClientConfig['onUnauthorized'];
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly captureAdmission: KiloChatClientConfig['captureOperationAdmission'];
  private readonly ownerCanPublish: KiloChatClientConfig['canPublish'];
  private readonly lifetime = new AbortController();
  private readonly operations = new WeakSet<KiloChatOperation>();
  private readonly subscriptions = new Set<() => void>();
  // Per-conversation send queues preserve caller order for server-assigned ULIDs.
  private readonly sendQueues = new Map<string, Promise<unknown>>();

  constructor(config: KiloChatClientConfig) {
    this.es = config.eventService;
    this.baseUrl = config.baseUrl;
    this.getToken = config.getToken;
    this.onUnauthorized = config.onUnauthorized;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.captureAdmission = config.captureOperationAdmission;
    this.ownerCanPublish = config.canPublish;
  }

  canPublish(): boolean {
    return !this.lifetime.signal.aborted && (this.ownerCanPublish?.() ?? true);
  }

  assertOwner(): void {
    if (!this.canPublish()) throw new Error('Kilo Chat owner is no longer active');
  }

  /** Capture before any caller queue; a supplied operation is never re-admitted. */
  captureOperation(operation?: KiloChatOperation): KiloChatOperation {
    this.assertOwner();
    if (operation) {
      if (!this.operations.has(operation)) throw new Error('Invalid Kilo Chat operation');
      operation.assertDispatch();
      return operation;
    }
    const assertAdmission = this.captureAdmission?.();
    const captured: KiloChatOperation = Object.freeze({
      assertDispatch: () => {
        this.assertOwner();
        assertAdmission?.();
      },
      canPublish: () => this.canPublish(),
    });
    captured.assertDispatch();
    this.operations.add(captured);
    return captured;
  }

  /** Protected announcements are not passive cache publication. */
  canStartOperation(): boolean {
    try {
      this.captureOperation();
      return true;
    } catch {
      return false;
    }
  }

  /** Opt-in teardown. Old callers that never dispose retain their lifecycle. */
  dispose(): void {
    this.lifetime.abort(new Error('Kilo Chat owner is no longer active'));
    this.sendQueues.clear();
    for (const off of this.subscriptions) off();
  }

  // ── Mutations via HTTP ────────────────────────────────────────────────────

  /**
   * Queue sends per conversation without renewing their original admission.
   * Timeout is uncertain: reconcile accepted server work before retrying.
   */
  async sendMessage(
    req: CreateMessageRequest,
    operation?: KiloChatOperation
  ): Promise<CreateMessageResponse> {
    const captured = this.captureOperation(operation);
    const send = () =>
      this.httpRequest('/v1/messages', {
        method: 'POST',
        body: req,
        schema: createMessageResponseSchema,
        deadlineMs: SEND_DEADLINE_MS,
        operation: captured,
      });
    const prev = this.sendQueues.get(req.conversationId) ?? Promise.resolve();
    // A failed prior send must not block subsequent sends.
    const next = prev.then(send, send);
    this.sendQueues.set(req.conversationId, next);
    const cleanup = (): void => {
      if (this.sendQueues.get(req.conversationId) === next) {
        this.sendQueues.delete(req.conversationId);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  async editMessage(
    messageId: string,
    req: EditMessageRequest,
    operation?: KiloChatOperation
  ): Promise<EditMessageResponse> {
    return this.httpRequest(`/v1/messages/${messageId}`, {
      method: 'PATCH',
      body: req,
      schema: editMessageResponseSchema,
      operation,
    });
  }

  async deleteMessage(
    messageId: string,
    req: z.input<typeof deleteMessageQuerySchema>,
    operation?: KiloChatOperation
  ): Promise<void> {
    await this.httpRequest(`/v1/messages/${messageId}`, {
      method: 'DELETE',
      query: req,
      schema: voidSchema,
      operation,
    });
  }

  async createConversation(
    req: CreateConversationRequest,
    operation?: KiloChatOperation
  ): Promise<CreateConversationResponse> {
    return this.httpRequest('/v1/conversations', {
      method: 'POST',
      body: req,
      schema: createConversationResponseSchema,
      operation,
    });
  }

  async renameConversation(
    conversationId: string,
    req: RenameConversationRequest,
    operation?: KiloChatOperation
  ): Promise<{ ok: true }> {
    return this.httpRequest(`/v1/conversations/${conversationId}`, {
      method: 'PATCH',
      body: req,
      schema: okResponseSchema,
      operation,
    });
  }

  async leaveConversation(conversationId: string, operation?: KiloChatOperation): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/leave`, {
      method: 'POST',
      schema: voidSchema,
      operation,
    });
  }

  async sendTyping(conversationId: string, operation?: KiloChatOperation): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/typing`, {
      method: 'POST',
      schema: voidSchema,
      operation,
    });
  }

  async sendTypingStop(conversationId: string): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/typing/stop`, {
      method: 'POST',
      schema: voidSchema,
      ownerOnly: true,
    });
  }

  async markConversationRead(
    conversationId: string,
    req: MarkConversationReadRequest,
    operation?: KiloChatOperation
  ): Promise<MarkConversationReadResponse> {
    return this.httpRequest(`/v1/conversations/${conversationId}/mark-read`, {
      method: 'POST',
      body: req,
      schema: markConversationReadResponseSchema,
      operation,
    });
  }

  async addReaction(
    messageId: string,
    req: z.input<typeof reactionRequestBodySchema>,
    operation?: KiloChatOperation
  ): Promise<AddReactionResponse> {
    return this.httpRequest(`/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      body: req,
      schema: addReactionResponseSchema,
      operation,
    });
  }

  async removeReaction(
    messageId: string,
    req: z.input<typeof reactionRequestBodySchema>,
    operation?: KiloChatOperation
  ): Promise<RemoveReactionResponse> {
    return this.httpRequest(`/v1/messages/${messageId}/reactions`, {
      method: 'DELETE',
      query: req,
      schema: removeReactionResponseSchema,
      operation,
    });
  }

  async redeliverMessage(
    conversationId: string,
    messageId: string,
    operation?: KiloChatOperation
  ): Promise<{ ok: true }> {
    return this.httpRequest(`/v1/conversations/${conversationId}/messages/${messageId}/redeliver`, {
      method: 'POST',
      schema: okResponseSchema,
      operation,
    });
  }

  async executeAction(
    conversationId: string,
    messageId: string,
    req: z.input<typeof executeActionRequestSchema>,
    operation?: KiloChatOperation
  ): Promise<ExecuteActionResponse> {
    return this.httpRequest(
      `/v1/conversations/${conversationId}/messages/${messageId}/execute-action`,
      { method: 'POST', body: req, schema: executeActionResponseSchema, operation }
    );
  }

  async initAttachment(
    req: AttachmentInitRequest,
    operation?: KiloChatOperation
  ): Promise<AttachmentInitResponse> {
    return this.httpRequest('/v1/attachments/init', {
      method: 'POST',
      body: req,
      schema: attachmentInitResponseSchema,
      operation,
    });
  }

  async getAttachmentUrl(req: AttachmentGetUrlRequest): Promise<AttachmentGetUrlResponse> {
    return this.httpRequest(`/v1/attachments/${encodeURIComponent(req.attachmentId)}/url`, {
      method: 'GET',
      query: { conversationId: req.conversationId },
      schema: attachmentGetUrlResponseSchema,
    });
  }

  // ── Queries via HTTP ──────────────────────────────────────────────────────

  async listConversations(
    opts?: z.input<typeof listConversationsQuerySchema>
  ): Promise<ConversationListResponse> {
    const query = {
      sandboxId: opts?.sandboxId,
      limit: opts?.limit,
      cursor: opts?.cursor,
    } satisfies z.input<typeof listConversationsQuerySchema>;
    return this.httpRequest('/v1/conversations', { query, schema: conversationListResponseSchema });
  }

  async getConversation(conversationId: string): Promise<ConversationDetailResponse> {
    return this.httpRequest(`/v1/conversations/${conversationId}`, {
      schema: conversationDetailResponseSchema,
    });
  }

  async getBotStatus(sandboxId: string): Promise<GetBotStatusResponse> {
    return this.httpRequest(`/v1/sandboxes/${sandboxId}/bot-status`, {
      schema: getBotStatusResponseSchema,
    });
  }

  // Status subscriptions nudge cached status; they do not admit foreground actions.
  async requestBotStatus(sandboxId: string): Promise<RequestBotStatusResponse> {
    return this.httpRequest(`/v1/sandboxes/${sandboxId}/request-bot-status`, {
      method: 'POST',
      schema: requestBotStatusResponseSchema,
      ownerOnly: true,
    });
  }

  async getConversationStatus(conversationId: string): Promise<GetConversationStatusResponse> {
    return this.httpRequest(`/v1/conversations/${conversationId}/conversation-status`, {
      schema: getConversationStatusResponseSchema,
    });
  }

  async listMessages(
    conversationId: string,
    opts?: z.input<typeof listMessagesQuerySchema>
  ): Promise<Message[]> {
    const res = await this.listMessagesPage(conversationId, opts);
    this.assertOwner();
    return res.messages;
  }

  async listMessagesPage(
    conversationId: string,
    opts?: z.input<typeof listMessagesQuerySchema>
  ): Promise<MessageListResponse> {
    const query = { before: opts?.before, limit: opts?.limit } satisfies z.input<
      typeof listMessagesQuerySchema
    >;
    return this.httpRequest(`/v1/conversations/${conversationId}/messages`, {
      query,
      schema: messageListResponseSchema,
    });
  }

  // ── Typed event subscriptions ─────────────────────────────────────────────

  on<N extends KiloChatEventName>(
    event: N,
    handler: (ctx: string, payload: KiloChatEventOf<N>) => void
  ): () => void {
    if (!this.canPublish()) return () => {};
    const payloadSchema = getKiloChatEventPayloadSchema(event);
    const unsubscribe = this.es.on(event, (context, payload) => {
      if (!this.canPublish()) return;
      const result = payloadSchema.safeParse(payload);
      if (!result.success) return;
      handler(context, result.data);
    });
    const off = () => {
      unsubscribe();
      this.subscriptions.delete(off);
    };
    this.subscriptions.add(off);
    return off;
  }

  onMessageCreated(handler: (ctx: string, e: MessageCreatedEvent) => void): () => void {
    return this.on('message.created', handler);
  }

  onMessageUpdated(handler: (ctx: string, e: MessageUpdatedEvent) => void): () => void {
    return this.on('message.updated', handler);
  }

  onMessageDeleted(handler: (ctx: string, e: MessageDeletedEvent) => void): () => void {
    return this.on('message.deleted', handler);
  }

  onMessageDeliveryFailed(
    handler: (ctx: string, e: MessageDeliveryFailedEvent) => void
  ): () => void {
    return this.on('message.delivery_failed', handler);
  }

  onMessageRedelivered(handler: (ctx: string, e: MessageRedeliveredEvent) => void): () => void {
    return this.on('message.redelivered', handler);
  }

  onActionDeliveryFailed(handler: (ctx: string, e: ActionDeliveryFailedEvent) => void): () => void {
    return this.on('action.delivery_failed', handler);
  }

  onTyping(handler: (ctx: string, e: TypingEvent) => void): () => void {
    return this.on('typing', handler);
  }

  onTypingStop(handler: (ctx: string, e: TypingEvent) => void): () => void {
    return this.on('typing.stop', handler);
  }

  onReactionAdded(handler: (ctx: string, e: ReactionAddedEvent) => void): () => void {
    return this.on('reaction.added', handler);
  }

  onReactionRemoved(handler: (ctx: string, e: ReactionRemovedEvent) => void): () => void {
    return this.on('reaction.removed', handler);
  }

  onConversationCreated(handler: (ctx: string, e: ConversationCreatedEvent) => void): () => void {
    return this.on('conversation.created', handler);
  }

  onConversationRenamed(handler: (ctx: string, e: ConversationRenamedEvent) => void): () => void {
    return this.on('conversation.renamed', handler);
  }

  onConversationLeft(handler: (ctx: string, e: ConversationLeftEvent) => void): () => void {
    return this.on('conversation.left', handler);
  }

  onConversationRead(handler: (ctx: string, e: ConversationReadEvent) => void): () => void {
    return this.on('conversation.read', handler);
  }

  onConversationActivity(handler: (ctx: string, e: ConversationActivityEvent) => void): () => void {
    return this.on('conversation.activity', handler);
  }

  onBotStatus(handler: (ctx: string, e: BotStatusEvent) => void): () => void {
    return this.on('bot.status', handler);
  }

  onConversationStatus(handler: (ctx: string, e: ConversationStatusEvent) => void): () => void {
    return this.on('conversation.status', handler);
  }

  // ── Private HTTP helper ───────────────────────────────────────────────────

  private async httpRequest<T>(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      query?: Record<string, unknown>;
      schema: z.ZodType<T>;
      deadlineMs?: number;
      operation?: KiloChatOperation;
      ownerOnly?: boolean;
    }
  ): Promise<T> {
    this.assertOwner();
    const operation =
      opts.method && opts.method !== 'GET' && !opts.ownerOnly
        ? this.captureOperation(opts.operation)
        : undefined;
    const assertDispatch = () => {
      this.assertOwner();
      operation?.assertDispatch();
    };
    const result = await withDeadline(
      opts.deadlineMs ?? CONTROL_PLANE_DEADLINE_MS,
      async signal => {
        const request = { ...opts, signal, assertDispatch };
        try {
          return await this.httpRequestOnce(path, request);
        } catch (err) {
          // Deadline/timeout errors must NOT trigger unauthorized recovery.
          const onUnauthorized = this.onUnauthorized;
          if (!this.shouldRecoverFromUnauthorized(err) || onUnauthorized === undefined) throw err;
          assertDispatch();
          const decision = await onUnauthorized();
          assertDispatch();
          if (decision !== 'retry') throw err;
          return this.httpRequestOnce(path, request);
        }
      },
      this.lifetime.signal
    );
    this.assertOwner();
    return result;
  }

  private shouldRecoverFromUnauthorized(err: unknown): err is KiloChatApiError {
    return (
      this.onUnauthorized !== undefined &&
      err instanceof KiloChatApiError &&
      (err.status === 401 || err.status === 403)
    );
  }

  private async httpRequestOnce<T>(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      query?: Record<string, unknown>;
      schema: z.ZodType<T>;
      signal: AbortSignal;
      assertDispatch: () => void;
    }
  ): Promise<T> {
    opts.assertDispatch();
    if (opts.signal.aborted) throw opts.signal.reason;
    const token = await this.getToken();
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (typeof v === 'string') params.set(k, v);
        else if (typeof v === 'number' || typeof v === 'boolean') params.set(k, v.toString());
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    opts.assertDispatch();
    if (opts.signal.aborted) throw opts.signal.reason;
    const res = await this.fetchFn(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    // A lock cannot undo accepted server work; replacement cannot publish it.
    this.assertOwner();
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      this.assertOwner();
      throw new KiloChatApiError(res.status, body);
    }
    if (res.status === 204) return opts.schema.parse(undefined);
    const json: unknown = await res.json();
    this.assertOwner();
    return opts.schema.parse(json);
  }
}
