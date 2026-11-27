declare type Hyperdrive = {
  connectionString: string;
};

declare type Message<T> = {
  body: T;
  attempts: number;
  ack(): void;
  retry(): void;
};

declare type MessageBatch<T> = {
  queue?: string;
  messages: Array<Message<T>>;
};

declare type MessageSendRequest<T> = {
  body: T;
  contentType: 'json' | 'text' | 'bytes' | 'v8';
};

declare type Queue<T> = {
  sendBatch(messages: Array<MessageSendRequest<T>>): Promise<void>;
};

declare type GitTokenService = {
  getToken(
    installationId: string,
    appType?: 'standard' | 'lite',
    expectedIntegrationId?: string,
    allowAuthenticationRecovery?: boolean
  ): Promise<string>;
};

declare type SecretBinding = {
  get(): Promise<string>;
};

declare type ScheduledController = {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
};

declare type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

/** The workerd built-in; only the `sts` secrets source loads it (src/secrets.ts). */
declare module 'cloudflare:workers' {
  export function waitUntil(promise: Promise<unknown>): void;
}

declare type CloudflareEnv = {
  INTERNAL_API_SECRET: SecretBinding;
  /** Production only; `env.dev` binds no STS. */
  STS?: import('@kilocode/secrets-client').BundleBinding;
  SYNC_QUEUE: Queue<import('./src/index').SecuritySyncQueueMessage>;
  DISMISS_QUEUE: Queue<import('./src/index').SecurityDismissMessage>;
  HYPERDRIVE: Hyperdrive;
  GIT_TOKEN_SERVICE: GitTokenService;
  ENVIRONMENT: string;
  MANUAL_SYNC_COMMAND_ROUTING_ENABLED: string | undefined;
  DISMISS_FINDING_COMMAND_ROUTING_ENABLED: string | undefined;
  BACKEND_API_URL: string | undefined;
  SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED: string | undefined;
  SECURITY_NOTIFICATION_DISPATCH_ENABLED: string | undefined;
  SECRETS_SOURCE: string | undefined;
};
