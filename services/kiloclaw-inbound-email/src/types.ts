import type { BundleBinding } from '@kilocode/secrets-client';

export type InboundEmailQueueMessage = {
  instanceId: string;
  recipientAlias: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
};

export type AppEnv = Env & {
  INBOUND_EMAIL_QUEUE: Queue<InboundEmailQueueMessage>;
  // `wrangler types` has not run for the SecretsBroker binding yet; this is its RPC shape
  // (packages/secrets-client `BundleBinding`). Absent until the binding deploys.
  STS?: BundleBinding;
  SECRETS_SOURCE?: string;
};
