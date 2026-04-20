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
} from './types';

function parseMessageRow(row: MessageRow): Message {
  return { ...row, content: row.content as unknown as ContentBlock[] };
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

  // ── Mutations via event-service RPC ──────────────────────────────────────

  async sendMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
    return this.es.rpc('kilo-chat', 'sendMessage', req);
  }

  async editMessage(messageId: string, req: EditMessageRequest): Promise<EditMessageResponse> {
    return this.es.rpc('kilo-chat', 'editMessage', { ...req, messageId });
  }

  async deleteMessage(messageId: string, req: DeleteMessageRequest): Promise<void> {
    return this.es.rpc('kilo-chat', 'deleteMessage', { ...req, messageId });
  }

  async createConversation(req: CreateConversationRequest): Promise<CreateConversationResponse> {
    return this.es.rpc('kilo-chat', 'createConversation', req);
  }

  async renameConversation(
    conversationId: string,
    req: RenameConversationRequest
  ): Promise<{ ok: true }> {
    return this.es.rpc('kilo-chat', 'renameConversation', { ...req, conversationId });
  }

  async leaveConversation(conversationId: string): Promise<void> {
    return this.es.rpc('kilo-chat', 'leaveConversation', { conversationId });
  }

  async sendTyping(conversationId: string): Promise<void> {
    return this.es.rpc('kilo-chat', 'sendTyping', { conversationId });
  }

  async markConversationRead(conversationId: string): Promise<void> {
    return this.es.rpc('kilo-chat', 'markRead', { conversationId });
  }

  async addReaction(
    messageId: string,
    conversationId: string,
    emoji: string
  ): Promise<{ id: string; added: boolean }> {
    return this.es.rpc('kilo-chat', 'addReaction', { messageId, conversationId, emoji });
  }

  async removeReaction(
    messageId: string,
    conversationId: string,
    emoji: string
  ): Promise<{ ok: true }> {
    return this.es.rpc('kilo-chat', 'removeReaction', { messageId, conversationId, emoji });
  }

  // ── Queries via HTTP ──────────────────────────────────────────────────────

  async listConversations(sandboxId?: string): Promise<ConversationListResponse> {
    return this.httpRequest('/v1/conversations', {
      query: sandboxId ? { sandboxId } : undefined,
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

  onReactionAdded(handler: (ctx: string, e: ReactionAddedEvent) => void): () => void {
    return this.es.on('reaction.added', handler as (context: string, payload: unknown) => void);
  }

  onReactionRemoved(handler: (ctx: string, e: ReactionRemovedEvent) => void): () => void {
    return this.es.on('reaction.removed', handler as (context: string, payload: unknown) => void);
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
