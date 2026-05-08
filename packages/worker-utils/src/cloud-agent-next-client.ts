/**
 * Lightweight, fetch-based client for cloud-agent-next tRPC endpoints.
 *
 * Designed to work in Cloudflare Workers (no Node.js dependencies) so both
 * the code-review orchestrator DO and the Next.js server can share the same
 * typed interface. The Next.js `CloudAgentNextClient` wraps a full tRPC client
 * with Sentry and credit-error handling; this module covers only the raw HTTP
 * transport layer and response parsing.
 */

// ---------------------------------------------------------------------------
// Types — aligned with cloud-agent-next tRPC router contracts
// ---------------------------------------------------------------------------

export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

export type CloudAgentPrepareSessionInput = {
  prompt: string;
  mode: string;
  model: string;
  variant?: string;
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  platform?: 'github' | 'gitlab';
  kilocodeOrganizationId?: string;
  envVars?: Record<string, string>;
  mcpServers?: Record<string, unknown>;
  upstreamBranch?: string;
  callbackTarget?: CallbackTarget;
  createdOnPlatform?: string;
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
};

export type CloudAgentPrepareSessionOutput = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  sandboxId: string;
};

export type CloudAgentInitiateInput = {
  cloudAgentSessionId: string;
};

export type CloudAgentInitiateOutput = {
  executionId: string;
  status?: string;
};

export type CloudAgentUpdateSessionInput = {
  cloudAgentSessionId: string;
  callbackTarget?: CallbackTarget | null;
  [key: string]: unknown;
};

export type CloudAgentSendMessageInput = {
  cloudAgentSessionId: string;
  prompt: string;
  mode: string;
  model: string;
  variant?: string;
  githubToken?: string;
  gitToken?: string;
};

export type CloudAgentSendMessageOutput = {
  executionId: string;
  status?: string;
};

export type CloudAgentInterruptInput = {
  sessionId: string;
};

export type CloudAgentInterruptOutput = {
  success: boolean;
  message: string;
  processesFound: boolean;
};

// ---------------------------------------------------------------------------
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Valid terminal reasons for code review failures.
 * KEEP IN SYNC with CODE_REVIEW_TERMINAL_REASONS / CodeReviewTerminalReason
 * in packages/db/src/schema-types.ts — both lists must contain the same
 * literal values. A mismatch will cause the orchestrator to send a reason
 * that normalizePayload rejects via its allowlist check.
 */
export type CloudAgentTerminalReason =
  | 'billing'
  | 'user_cancelled'
  | 'superseded'
  | 'interrupted'
  | 'timeout'
  | 'upstream_error'
  | 'sandbox_error'
  | 'unknown';

export const SANDBOX_DESTROYED_AFTER_500_ERROR = 'SANDBOX_DESTROYED_AFTER_500' as const;

export type CloudAgentNextSandboxDestroyedErrorData = {
  code: typeof SANDBOX_DESTROYED_AFTER_500_ERROR;
  sandboxId?: string;
  phase?: string;
  sessionId?: string;
  destroyedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readSandboxDestroyedData(
  value: unknown
): CloudAgentNextSandboxDestroyedErrorData | undefined {
  if (!isRecord(value)) return undefined;

  const marker = getStringProperty(value, 'error') ?? getStringProperty(value, 'code');
  if (marker === SANDBOX_DESTROYED_AFTER_500_ERROR) {
    const sessionId =
      getStringProperty(value, 'sessionId') ?? getStringProperty(value, 'triggeringSessionId');
    const data: CloudAgentNextSandboxDestroyedErrorData = {
      code: SANDBOX_DESTROYED_AFTER_500_ERROR,
      sandboxId: getStringProperty(value, 'sandboxId'),
      phase: getStringProperty(value, 'phase'),
      destroyedAt: getStringProperty(value, 'destroyedAt'),
    };
    if (sessionId) data.sessionId = sessionId;
    return data;
  }

  const error = value.error;
  if (isRecord(error)) {
    const fromError = readSandboxDestroyedData(error);
    if (fromError) return fromError;
  }

  const data = value.data;
  if (isRecord(data)) {
    const fromData = readSandboxDestroyedData(data);
    if (fromData) return fromData;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const fromItem = readSandboxDestroyedData(item);
      if (fromItem) return fromItem;
    }
  }

  return undefined;
}

export function parseCloudAgentNextSandboxDestroyedError(
  body: string
): CloudAgentNextSandboxDestroyedErrorData | undefined {
  return readSandboxDestroyedData(parseJsonObject(body));
}

export function getCloudAgentNextSandboxDestroyedError(
  error: unknown
): CloudAgentNextSandboxDestroyedErrorData | undefined {
  if (error instanceof CloudAgentNextError) {
    return error.sandboxDestroyedAfter500;
  }
  return undefined;
}

export class CloudAgentNextError extends Error {
  readonly procedure: string;
  readonly status: number;
  readonly body: string;
  readonly sandboxDestroyedAfter500?: CloudAgentNextSandboxDestroyedErrorData;

  constructor(procedure: string, status: number, body: string) {
    super(`${procedure} failed (${status}): ${body}`);
    this.name = 'CloudAgentNextError';
    this.procedure = procedure;
    this.status = status;
    this.body = body;
    this.sandboxDestroyedAfter500 = parseCloudAgentNextSandboxDestroyedError(body);
  }
}

export class CloudAgentNextBillingError extends CloudAgentNextError {
  readonly terminalReason = 'billing' satisfies CloudAgentTerminalReason;

  constructor(procedure: string, status: number, body: string) {
    super(procedure, status, body);
    this.name = 'CloudAgentNextBillingError';
  }
}

function isBillingErrorBody(body: string): boolean {
  return ['insufficient credits', 'paid model', 'add credits', 'credits required'].some(pattern =>
    body.toLowerCase().includes(pattern)
  );
}

/**
 * Parse a tRPC JSON-RPC envelope and return `result.data`, throwing on
 * non-200 responses or unexpected shapes.
 */
async function trpcPost<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  procedure: string
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 402 || isBillingErrorBody(errorText)) {
      throw new CloudAgentNextBillingError(procedure, response.status, errorText);
    }
    throw new CloudAgentNextError(procedure, response.status, errorText);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const data = (json?.result as Record<string, unknown> | undefined)?.data;
  if (data === undefined) {
    throw new Error(
      `Unexpected ${procedure} response shape: ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export type CloudAgentNextFetchClient = {
  prepareSession(
    headers: Record<string, string>,
    input: CloudAgentPrepareSessionInput
  ): Promise<CloudAgentPrepareSessionOutput>;

  initiateFromPreparedSession(
    headers: Record<string, string>,
    input: CloudAgentInitiateInput
  ): Promise<CloudAgentInitiateOutput>;

  updateSession(
    headers: Record<string, string>,
    input: CloudAgentUpdateSessionInput
  ): Promise<void>;

  sendMessageV2(
    headers: Record<string, string>,
    input: CloudAgentSendMessageInput
  ): Promise<CloudAgentSendMessageOutput>;

  interruptSession(
    headers: Record<string, string>,
    input: CloudAgentInterruptInput
  ): Promise<CloudAgentInterruptOutput>;
};

/**
 * Create a typed, fetch-based client for cloud-agent-next tRPC endpoints.
 *
 * The caller is responsible for assembling the correct headers (Bearer token,
 * internal API key, skip-balance-check, etc.) because different procedures
 * require different auth levels.
 */
export function createCloudAgentNextFetchClient(baseUrl: string): CloudAgentNextFetchClient {
  const trpc = (procedure: string) => `${baseUrl}/trpc/${procedure}`;

  return {
    async prepareSession(headers, input) {
      const data = await trpcPost<Record<string, unknown>>(
        trpc('prepareSession'),
        headers,
        input,
        'prepareSession'
      );
      if (
        typeof data.cloudAgentSessionId !== 'string' ||
        typeof data.kiloSessionId !== 'string' ||
        typeof data.sandboxId !== 'string'
      ) {
        throw new Error(
          `Unexpected prepareSession response shape: ${JSON.stringify(data).slice(0, 500)}`
        );
      }
      return data as unknown as CloudAgentPrepareSessionOutput;
    },

    async initiateFromPreparedSession(headers, input) {
      const data = await trpcPost<Record<string, unknown>>(
        trpc('initiateFromKilocodeSessionV2'),
        headers,
        input,
        'initiateFromKilocodeSessionV2'
      );
      if (typeof data.executionId !== 'string') {
        throw new Error(
          `Unexpected initiateFromKilocodeSessionV2 response shape: ${JSON.stringify(data).slice(0, 500)}`
        );
      }
      return data as unknown as CloudAgentInitiateOutput;
    },

    async updateSession(headers, input) {
      await trpcPost<unknown>(trpc('updateSession'), headers, input, 'updateSession');
    },

    async sendMessageV2(headers, input) {
      const data = await trpcPost<Record<string, unknown>>(
        trpc('sendMessageV2'),
        headers,
        input,
        'sendMessageV2'
      );
      if (typeof data.executionId !== 'string') {
        throw new Error(
          `Unexpected sendMessageV2 response shape: ${JSON.stringify(data).slice(0, 500)}`
        );
      }
      return data as unknown as CloudAgentSendMessageOutput;
    },

    async interruptSession(headers, input) {
      return trpcPost<CloudAgentInterruptOutput>(
        trpc('interruptSession'),
        headers,
        input,
        'interruptSession'
      );
    },
  };
}
