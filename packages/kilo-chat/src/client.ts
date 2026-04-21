import { KiloChatApiError } from './errors';
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
  DeleteMessageRequest,
  RenameConversationRequest,
  MessageListResponse,
  Message,
  MessageRow,
  ContentBlock,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  TypingEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  ConversationCreatedEvent,
  ConversationRenamedEvent,
  ConversationLeftEvent,
  ConversationReadEvent,
  ConversationActivityEvent,
} from './types';

function parseMessageRow(row: MessageRow): Message {
  return { ...row, content: JSON.parse(row.content) as ContentBlock[] };
}

export class KiloChatClient {
  private readonly es: KiloChatClientConfig['eventService'];
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: KiloChatClientConfig) {
    this.es = config.eventService;
    this.baseUrl = config.baseUrl;
    this.getToken = config.getToken;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── Mutations via HTTP ────────────────────────────────────────────────────

  async sendMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
    return this.httpRequest('/v1/messages', { method: 'POST', body: req });
  }

  async editMessage(messageId: string, req: EditMessageRequest): Promise<EditMessageResponse> {
    return this.httpRequest(`/v1/messages/${messageId}`, { method: 'PATCH', body: req });
  }

  async deleteMessage(messageId: string, req: DeleteMessageRequest): Promise<void> {
    return this.httpRequest(`/v1/messages/${messageId}`, {
      method: 'DELETE',
      body: req,
    });
  }

  async createConversation(req: CreateConversationRequest): Promise<CreateConversationResponse> {
    return this.httpRequest('/v1/conversations', { method: 'POST', body: req });
  }

  async renameConversation(
    conversationId: string,
    req: RenameConversationRequest
  ): Promise<{ ok: true }> {
    return this.httpRequest(`/v1/conversations/${conversationId}`, { method: 'PATCH', body: req });
  }

  async leaveConversation(conversationId: string): Promise<void> {
    return this.httpRequest(`/v1/conversations/${conversationId}/leave`, { method: 'POST' });
  }

  async sendTyping(conversationId: string): Promise<void> {
    return this.httpRequest(`/v1/conversations/${conversationId}/typing`, { method: 'POST' });
  }

  async sendTypingStop(conversationId: string): Promise<void> {
    return this.httpRequest(`/v1/conversations/${conversationId}/typing/stop`, { method: 'POST' });
  }

  async markConversationRead(conversationId: string): Promise<void> {
    return this.httpRequest(`/v1/conversations/${conversationId}/mark-read`, { method: 'POST' });
  }

  async addReaction(
    messageId: string,
    conversationId: string,
    emoji: string
  ): Promise<{ id: string; added: boolean }> {
    return this.httpRequest(`/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      body: { conversationId, emoji },
    });
  }

  async removeReaction(
    messageId: string,
    conversationId: string,
    emoji: string
  ): Promise<{ ok: true }> {
    return this.httpRequest(`/v1/messages/${messageId}/reactions`, {
      method: 'DELETE',
      query: { conversationId, emoji },
    });
  }

  // ── Queries via HTTP ──────────────────────────────────────────────────────

  async listConversations(
    sandboxId?: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<ConversationListResponse> {
    return this.httpRequest('/v1/conversations', {
      query: { sandboxId, limit: opts?.limit, offset: opts?.offset },
    });
  }

  async getConversation(conversationId: string): Promise<ConversationDetailResponse> {
    return this.httpRequest(`/v1/conversations/${conversationId}`);
  }

  async listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number }
  ): Promise<Message[]> {
    const res = await this.httpRequest<MessageListResponse>(
      `/v1/conversations/${conversationId}/messages`,
      { query: { before: opts?.before, limit: opts?.limit } }
    );
    return res.messages.map(parseMessageRow);
  }

  // ── Typed event subscriptions ─────────────────────────────────────────────

  onMessageCreated(handler: (ctx: string, e: MessageCreatedEvent) => void): () => void {
    return this.es.on('message.created', handler as (context: string, payload: unknown) => void);
  }

  onMessageUpdated(handler: (ctx: string, e: MessageUpdatedEvent) => void): () => void {
    return this.es.on('message.updated', handler as (context: string, payload: unknown) => void);
  }

  onMessageDeleted(handler: (ctx: string, e: MessageDeletedEvent) => void): () => void {
    return this.es.on('message.deleted', handler as (context: string, payload: unknown) => void);
  }

  onMessageDeliveryFailed(
    handler: (ctx: string, e: MessageDeliveryFailedEvent) => void
  ): () => void {
    return this.es.on(
      'message.delivery_failed',
      handler as (context: string, payload: unknown) => void
    );
  }

  onTyping(handler: (ctx: string, e: TypingEvent) => void): () => void {
    return this.es.on('typing', handler as (context: string, payload: unknown) => void);
  }

  onTypingStop(handler: (ctx: string, e: TypingEvent) => void): () => void {
    return this.es.on('typing.stop', handler as (context: string, payload: unknown) => void);
  }

  onReactionAdded(handler: (ctx: string, e: ReactionAddedEvent) => void): () => void {
    return this.es.on('reaction.added', handler as (context: string, payload: unknown) => void);
  }

  onReactionRemoved(handler: (ctx: string, e: ReactionRemovedEvent) => void): () => void {
    return this.es.on('reaction.removed', handler as (context: string, payload: unknown) => void);
  }

  onConversationCreated(handler: (ctx: string, e: ConversationCreatedEvent) => void): () => void {
    return this.es.on(
      'conversation.created',
      handler as (context: string, payload: unknown) => void
    );
  }

  onConversationRenamed(handler: (ctx: string, e: ConversationRenamedEvent) => void): () => void {
    return this.es.on(
      'conversation.renamed',
      handler as (context: string, payload: unknown) => void
    );
  }

  onConversationLeft(handler: (ctx: string, e: ConversationLeftEvent) => void): () => void {
    return this.es.on('conversation.left', handler as (context: string, payload: unknown) => void);
  }

  onConversationRead(handler: (ctx: string, e: ConversationReadEvent) => void): () => void {
    return this.es.on('conversation.read', handler as (context: string, payload: unknown) => void);
  }

  onConversationActivity(handler: (ctx: string, e: ConversationActivityEvent) => void): () => void {
    return this.es.on(
      'conversation.activity',
      handler as (context: string, payload: unknown) => void
    );
  }

  // ── Private HTTP helper ───────────────────────────────────────────────────

  private async httpRequest<T>(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | number | undefined>;
    } = {}
  ): Promise<T> {
    const token = await this.getToken();
    let url = `${this.baseUrl}${path}`;

    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, String(v));
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

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
}
