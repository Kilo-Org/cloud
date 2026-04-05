/**
 * CloudAgentClient
 *
 * Encapsulates Cloud Agent API interactions.
 * Handles URL construction, fetch logic, and error handling.
 */

type SessionInput = {
  githubRepo: string;
  kilocodeOrganizationId?: string;
  prompt: string;
  mode: 'ask' | 'code';
  model: string;
  githubToken?: string;
  autoCommit?: boolean;
  upstreamBranch?: string;
  callbackUrl?: string;
  callbackHeaders?: Record<string, string>;
};

export class CloudAgentClient {
  constructor(
    private baseUrl: string,
    private authToken: string
  ) {}

  /**
   * Initiate a streaming session (for classification)
   */
  async initiateSession(sessionInput: SessionInput, ticketId: string): Promise<Response> {
    const inputJson = JSON.stringify(sessionInput);
    const encodedInput = encodeURIComponent(inputJson);
    const url = `${this.baseUrl}/trpc/initiateSessionStream?input=${encodedInput}`;

    console.log('[CloudAgentClient] Initiating streaming session', {
      ticketId,
      url: url.split('?')[0],
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          Accept: 'text/event-stream',
        },
      });

      console.log('[CloudAgentClient] Fetch response received', {
        ticketId,
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        timestamp: new Date().toISOString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud Agent returned ${response.status}: ${errorText}`);
      }

      return response;
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      console.error('[CloudAgentClient] Failed to fetch from Cloud Agent', {
        ticketId,
        error: errorMessage,
        url: url.split('?')[0],
      });
      throw new Error(`Failed to connect to Cloud Agent: ${errorMessage}`);
    }
  }

  /**
   * Initiate an async session with callbacks (for PR creation)
   */
  async initiateSessionAsync(sessionInput: SessionInput, ticketId: string): Promise<Response> {
    const inputJson = JSON.stringify(sessionInput);
    const encodedInput = encodeURIComponent(inputJson);
    const url = `${this.baseUrl}/trpc/initiateSessionAsync?input=${encodedInput}`;

    console.log('[CloudAgentClient] Initiating async session', {
      ticketId,
      url: url.split('?')[0],
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          Accept: 'text/event-stream',
        },
      });

      console.log('[CloudAgentClient] Fetch response received', {
        ticketId,
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        timestamp: new Date().toISOString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud Agent returned ${response.status}: ${errorText}`);
      }

      return response;
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      console.error('[CloudAgentClient] Failed to fetch from Cloud Agent', {
        ticketId,
        error: errorMessage,
        url: url.split('?')[0],
      });
      throw new Error(`Failed to connect to Cloud Agent: ${errorMessage}`);
    }
  }
}
