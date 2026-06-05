declare type Hyperdrive = {
  connectionString: string;
};

declare type Message<T> = {
  body: T;
  ack(): void;
  retry(): void;
};

declare type MessageBatch<T> = {
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
  getToken(installationId: string, appType?: 'standard' | 'lite'): Promise<string>;
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

declare type CloudflareEnv = {
  SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL: string | undefined;
  INTERNAL_API_SECRET: SecretBinding;
  SYNC_QUEUE: Queue<import('./src/index').SecuritySyncQueueMessage>;
  HYPERDRIVE: Hyperdrive;
  GIT_TOKEN_SERVICE: GitTokenService;
  MANUAL_SYNC_COMMAND_ROUTING_ENABLED: string | undefined;
  DISMISS_FINDING_COMMAND_ROUTING_ENABLED: string | undefined;
};
