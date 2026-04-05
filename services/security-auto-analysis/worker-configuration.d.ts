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
  queue: string;
  messages: Array<Message<T>>;
};

declare type MessageSendRequest<T> = {
  body: T;
  contentType: 'json' | 'text' | 'bytes' | 'v8';
};

declare type Queue<T> = {
  sendBatch(messages: Array<MessageSendRequest<T>>): Promise<void>;
};

declare type GitTokenForRepoResult =
  | {
      success: true;
      token: string;
      installationId: string;
      accountLogin: string;
      appType: 'standard' | 'lite';
    }
  | {
      success: false;
      reason:
        | 'database_not_configured'
        | 'invalid_repo_format'
        | 'no_installation_found'
        | 'invalid_org_id';
    };

declare type GitTokenService = {
  getTokenForRepo(params: {
    githubRepo: string;
    userId: string;
    orgId?: string;
  }): Promise<GitTokenForRepoResult>;
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
  HYPERDRIVE: Hyperdrive;
  OWNER_QUEUE: Queue<import('./src/types').AutoAnalysisOwnerMessage>;
  CLOUD_AGENT_NEXT: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  GIT_TOKEN_SERVICE: GitTokenService;
  NEXTAUTH_SECRET: SecretBinding;
  INTERNAL_API_SECRET: SecretBinding;
  KILOCODE_BACKEND_BASE_URL: string;
  ENVIRONMENT: string;
  BETTERSTACK_HEARTBEAT_URL: string | undefined;
};

declare type GitTokenLookupFailureReason = Extract<
  GitTokenForRepoResult,
  { success: false }
>['reason'];
