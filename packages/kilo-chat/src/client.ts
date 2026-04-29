import { z } from 'zod';
import { KiloChatApiError } from './errors';
import {
  conversationListResponseSchema,
  conversationDetailResponseSchema,
  createConversationResponseSchema,
  createMessageResponseSchema,
  editMessageResponseSchema,
  messageListResponseSchema,
  addReactionResponseSchema,
  okResponseSchema,
  getBotStatusResponseSchema,
  getConversationStatusResponseSchema,
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
  ConversationListResponse,
  ConversationDetailResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  EditMessageRequest,
  EditMessageResponse,
  RenameConversationRequest,
  Message,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  ActionDeliveryFailedEvent,
  TypingEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  ConversationCreatedEvent,
  ConversationRenamedEvent,
  ConversationLeftEvent,
  ConversationReadEvent,
  ConversationActivityEvent,
  BotStatusEvent,
  ConversationStatusEvent,
  GetBotStatusResponse,
  GetConversationStatusResponse,
} from './types';

// Accept any response body for fire-and-forget endpoints. The server may
// return `{}` (200) or no body (204); the client doesn't inspect either.
const voidSchema = z.unknown();

export class KiloChatClient {
  private readonly es: KiloChatClientConfig['eventService'];
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: typeof globalThis.fetch;
  // Per-conversation send queues. Each sendMessage call chains onto the tail
  // of its conversation's queue so concurrent callers cannot race ahead of
  // earlier sends and get a lower server-assigned ULID than a later send.
  // See services/kilo-chat/src/do/conversation-do.ts (nextUlid is monotonic
  // in DO arrival order, not caller send order).
  private readonly sendQueues = new Map<string, Promise<unknown>>();

  constructor(config: KiloChatClientConfig) {
    this.es = config.eventService;
    this.baseUrl = config.baseUrl;
    this.getToken = config.getToken;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── Mutations via HTTP ────────────────────────────────────────────────────

  async sendMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
    const prev = this.sendQueues.get(req.conversationId) ?? Promise.resolve();
    const next = prev.then(
      () =>
        this.httpRequest('/v1/messages', {
          method: 'POST',
          body: req,
          schema: createMessageResponseSchema,
        }),
      // A failed prior send must not block subsequent sends — swallow the
      // rejection on the chain; the original caller already received it.
      () =>
        this.httpRequest('/v1/messages', {
          method: 'POST',
          body: req,
          schema: createMessageResponseSchema,
        })
    );
    this.sendQueues.set(req.conversationId, next);
    // Best-effort cleanup so the map doesn't grow unbounded for long-lived
    // clients. Only clear if this send is still the tail.
    void next.finally(() => {
      if (this.sendQueues.get(req.conversationId) === next) {
        this.sendQueues.delete(req.conversationId);
      }
    });
    return next;
  }

  async editMessage(messageId: string, req: EditMessageRequest): Promise<EditMessageResponse> {
    return this.httpRequest(`/v1/messages/${messageId}`, {
      method: 'PATCH',
      body: req,
      schema: editMessageResponseSchema,
    });
  }

  async deleteMessage(
    messageId: string,
    req: z.input<typeof deleteMessageQuerySchema>
  ): Promise<void> {
    await this.httpRequest(`/v1/messages/${messageId}`, {
      method: 'DELETE',
      query: req,
      schema: voidSchema,
    });
  }

  async createConversation(req: CreateConversationRequest): Promise<CreateConversationResponse> {
    return this.httpRequest('/v1/conversations', {
      method: 'POST',
      body: req,
      schema: createConversationResponseSchema,
    });
  }

  async renameConversation(
    conversationId: string,
    req: RenameConversationRequest
  ): Promise<{ ok: true }> {
    return this.httpRequest(`/v1/conversations/${conversationId}`, {
      method: 'PATCH',
      body: req,
      schema: okResponseSchema,
    });
  }

  async leaveConversation(conversationId: string): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/leave`, {
      method: 'POST',
      schema: voidSchema,
    });
  }

  async sendTyping(conversationId: string): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/typing`, {
      method: 'POST',
      schema: voidSchema,
    });
  }

  async sendTypingStop(conversationId: string): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/typing/stop`, {
      method: 'POST',
      schema: voidSchema,
    });
  }

  async markConversationRead(conversationId: string): Promise<void> {
    await this.httpRequest(`/v1/conversations/${conversationId}/mark-read`, {
      method: 'POST',
      schema: voidSchema,
    });
  }

  async addReaction(
    messageId: string,
    req: z.input<typeof reactionRequestBodySchema>
  ): Promise<{ id: string }> {
    return this.httpRequest(`/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      body: req,
      schema: addReactionResponseSchema,
    });
  }

  async removeReaction(
    messageId: string,
    req: z.input<typeof reactionRequestBodySchema>
  ): Promise<void> {
    await this.httpRequest(`/v1/messages/${messageId}/reactions`, {
      method: 'DELETE',
      query: req,
      schema: voidSchema,
    });
  }

  async executeAction(
    conversationId: string,
    messageId: string,
    req: z.input<typeof executeActionRequestSchema>
  ): Promise<{ ok: true }> {
    return this.httpRequest(
      `/v1/conversations/${conversationId}/messages/${messageId}/execute-action`,
      { method: 'POST', body: req, schema: okResponseSchema }
    );
  }

  // ── Queries via HTTP ──────────────────────────────────────────────────────

  async listConversations(
    opts?: z.input<typeof listConversationsQuerySchema>
  ): Promise<ConversationListResponse> {
    return this.httpRequest('/v1/conversations', {
      query: { sandboxId: opts?.sandboxId, limit: opts?.limit, cursor: opts?.cursor },
      schema: conversationListResponseSchema,
    });
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

  // Fire-and-forget: nudges the bot to push a fresh `bot.status` event over
  // event-service. Server dedupes per sandbox; subscribed clients call this
  // every ~15s while the user is on a chat surface.
  async requestBotStatus(sandboxId: string): Promise<void> {
    await this.httpRequest(`/v1/sandboxes/${sandboxId}/request-bot-status`, {
      method: 'POST',
      schema: voidSchema,
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
    const res = await this.httpRequest(`/v1/conversations/${conversationId}/messages`, {
      query: { before: opts?.before, limit: opts?.limit },
      schema: messageListResponseSchema,
    });
    return res.messages;
  }

  // ── Typed event subscriptions ─────────────────────────────────────────────

  on<N extends KiloChatEventName>(
    event: N,
    handler: (ctx: string, payload: KiloChatEventOf<N>) => void
  ): () => void {
    const payloadSchema = getKiloChatEventPayloadSchema(event);
    return this.es.on(event, (context, payload) => {
      const result = payloadSchema.safeParse(payload);
      if (!result.success) return;
      handler(context, result.data);
    });
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
    }
  ): Promise<T> {
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

    const res = await this.fetchFn(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      throw new KiloChatApiError(res.status, body);
    }

    if (res.status === 204) return opts.schema.parse(undefined);
    const json: unknown = await res.json();
    return opts.schema.parse(json);
  }
}
