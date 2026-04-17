import { KiloChatApiError } from './errors';
import type {
  KiloChatConfig,
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
} from './types';

function parseMessageRow(row: MessageRow): Message {
  return { ...row, content: row.content as unknown as ContentBlock[] };
}

export class KiloChatClient {
  private baseUrl: string;
  private getToken: () => Promise<string>;
  private fetchFn: typeof globalThis.fetch;

  constructor(config: KiloChatConfig) {
    this.baseUrl = config.baseUrl;
    this.getToken = config.getToken;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
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

  async listConversations(sandboxId?: string): Promise<ConversationListResponse> {
    const query = sandboxId ? `?sandboxId=${encodeURIComponent(sandboxId)}` : '';
    return this.request(`/v1/conversations${query}`);
  }

  async getConversation(conversationId: string): Promise<ConversationDetailResponse> {
    return this.request(`/v1/conversations/${conversationId}`);
  }

  async createConversation(req: CreateConversationRequest): Promise<CreateConversationResponse> {
    return this.request('/v1/conversations', { method: 'POST', body: req });
  }

  async listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number }
  ): Promise<Message[]> {
    const res = await this.request<MessageListResponse>(
      `/v1/conversations/${conversationId}/messages`,
      { query: { before: opts?.before, limit: opts?.limit } }
    );
    return res.messages.map(parseMessageRow);
  }

  async sendMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
    return this.request('/v1/messages', { method: 'POST', body: req });
  }

  async editMessage(messageId: string, req: EditMessageRequest): Promise<EditMessageResponse> {
    return this.request(`/v1/messages/${messageId}`, { method: 'PATCH', body: req });
  }

  async deleteMessage(messageId: string, req: DeleteMessageRequest): Promise<void> {
    return this.request(`/v1/messages/${messageId}`, { method: 'DELETE', body: req });
  }

  async renameConversation(
    conversationId: string,
    req: RenameConversationRequest
  ): Promise<{ ok: true }> {
    return this.request(`/v1/conversations/${conversationId}`, { method: 'PATCH', body: req });
  }

  async leaveConversation(conversationId: string): Promise<void> {
    return this.request(`/v1/conversations/${conversationId}/leave`, { method: 'POST' });
  }

  async sendTyping(conversationId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}/typing`, { method: 'POST' });
  }
}
