type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

type PrepareSessionInput = {
  githubRepo: string;
  kilocodeOrganizationId?: string;
  prompt: string;
  mode: 'ask' | 'code';
  model: string;
  githubToken?: string;
  autoCommit?: boolean;
  upstreamBranch?: string;
  createdOnPlatform?: string;
  callbackTarget?: CallbackTarget;
};

type PrepareSessionResponse = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
};

type InitiateSessionResponse = {
  executionId: string;
  cloudAgentSessionId: string;
  status: string;
};

/**
 * cloud-agent-next client for prepare/initiate flow.
 */
export class CloudAgentNextClient {
  constructor(
    private baseUrl: string,
    private authToken: string,
    private internalApiKey: string
  ) {}

  async prepareSession(
    input: PrepareSessionInput,
    ticketId: string
  ): Promise<PrepareSessionResponse> {
    const response = await fetch(`${this.baseUrl}/trpc/prepareSession`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        'x-internal-api-key': this.internalApiKey,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`prepareSession failed (${response.status}): ${errorText}`);
    }

    const result = await response.json<Record<string, unknown>>();
    const data = (result.result as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;

    if (
      !data ||
      typeof data.cloudAgentSessionId !== 'string' ||
      typeof data.kiloSessionId !== 'string'
    ) {
      throw new Error(
        `Unexpected prepareSession response shape for ticket ${ticketId}: ${JSON.stringify(result).slice(0, 500)}`
      );
    }

    return {
      cloudAgentSessionId: data.cloudAgentSessionId,
      kiloSessionId: data.kiloSessionId,
    };
  }

  async initiateFromPreparedSession(
    cloudAgentSessionId: string,
    ticketId: string
  ): Promise<InitiateSessionResponse> {
    const response = await fetch(`${this.baseUrl}/trpc/initiateFromKilocodeSessionV2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        'x-internal-api-key': this.internalApiKey,
      },
      body: JSON.stringify({ cloudAgentSessionId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`initiateFromKilocodeSessionV2 failed (${response.status}): ${errorText}`);
    }

    const result = await response.json<Record<string, unknown>>();
    const data = (result.result as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;

    if (!data || typeof data.executionId !== 'string' || typeof data.status !== 'string') {
      throw new Error(
        `Unexpected initiateFromKilocodeSessionV2 response shape for ticket ${ticketId}: ${JSON.stringify(result).slice(0, 500)}`
      );
    }

    return {
      executionId: data.executionId,
      cloudAgentSessionId:
        typeof data.cloudAgentSessionId === 'string'
          ? data.cloudAgentSessionId
          : cloudAgentSessionId,
      status: data.status,
    };
  }
}
