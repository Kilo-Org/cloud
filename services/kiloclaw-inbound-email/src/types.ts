export type InboundEmailQueueMessage = {
  instanceId: string;
  recipientKind: 'legacy' | 'alias';
  recipientAlias?: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
};

export type AppEnv = Env & {
  INBOUND_EMAIL_QUEUE: Queue<InboundEmailQueueMessage>;
};
