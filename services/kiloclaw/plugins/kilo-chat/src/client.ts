export type KiloChatClientOptions = {
  controllerBaseUrl: string;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
};

export type SendTextParams = {
  conversationId: string;
  text: string;
};

export type SendTextResult = {
  messageId: string;
};

export type KiloChatClient = {
  sendText(params: SendTextParams): Promise<SendTextResult>;
};

export function createKiloChatClient(options: KiloChatClientOptions): KiloChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async sendText(params) {
      const response = await fetchImpl(`${options.controllerBaseUrl}/_kilo/kilo-chat/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.gatewayToken}`,
        },
        body: JSON.stringify({
          conversationId: params.conversationId,
          text: params.text,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `kilo-chat: controller /send responded ${response.status}: ${await response.text()}`
        );
      }
      const data = (await response.json()) as { messageId?: string };
      if (typeof data.messageId !== 'string' || data.messageId.length === 0) {
        throw new Error('kilo-chat: controller /send response missing messageId');
      }
      return { messageId: data.messageId };
    },
  };
}
