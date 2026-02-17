import type { ApiResponse, Bead, BeadPriority, GastownEnv, Mail, PrimeContext } from './types';

function isApiResponse(value: unknown): value is ApiResponse<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as Record<string, unknown>).success === 'boolean'
  );
}

export class GastownClient {
  private baseUrl: string;
  private token: string;
  private agentId: string;
  private rigId: string;

  constructor(env: GastownEnv) {
    this.baseUrl = env.apiUrl.replace(/\/+$/, '');
    this.token = env.sessionToken;
    this.agentId = env.agentId;
    this.rigId = env.rigId;
  }

  private rigPath(path: string): string {
    return `${this.baseUrl}/api/rigs/${this.rigId}${path}`;
  }

  private agentPath(path: string): string {
    return this.rigPath(`/agents/${this.agentId}${path}`);
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GastownApiError(`Network error: ${message}`, 0);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GastownApiError(`Invalid JSON response (HTTP ${response.status})`, response.status);
    }

    if (!isApiResponse(body)) {
      throw new GastownApiError(
        `Unexpected response shape (HTTP ${response.status})`,
        response.status
      );
    }

    if (!body.success) {
      throw new GastownApiError((body as { error: string }).error, response.status);
    }

    return (body as { data: T }).data;
  }

  // -- Agent-scoped endpoints --

  async prime(): Promise<PrimeContext> {
    return this.request<PrimeContext>(this.agentPath('/prime'));
  }

  async done(input: { branch: string; pr_url?: string; summary?: string }): Promise<void> {
    await this.request<void>(this.agentPath('/done'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async checkMail(): Promise<Mail[]> {
    return this.request<Mail[]>(this.agentPath('/mail'));
  }

  async writeCheckpoint(data: unknown): Promise<void> {
    await this.request<void>(this.agentPath('/checkpoint'), {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  // -- Rig-scoped endpoints --

  async getBead(beadId: string): Promise<Bead> {
    return this.request<Bead>(this.rigPath(`/beads/${beadId}`));
  }

  async closeBead(beadId: string): Promise<Bead> {
    return this.request<Bead>(this.rigPath(`/beads/${beadId}/close`), {
      method: 'POST',
      body: JSON.stringify({ agent_id: this.agentId }),
    });
  }

  async sendMail(input: { to_agent_id: string; subject: string; body: string }): Promise<void> {
    await this.request<void>(this.rigPath('/mail'), {
      method: 'POST',
      body: JSON.stringify({
        from_agent_id: this.agentId,
        ...input,
      }),
    });
  }

  async createEscalation(input: {
    title: string;
    body?: string;
    priority?: BeadPriority;
    metadata?: Record<string, unknown>;
  }): Promise<Bead> {
    return this.request<Bead>(this.rigPath('/escalations'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}

export class GastownApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(`Gastown API error (${status}): ${message}`);
    this.name = 'GastownApiError';
    this.status = status;
  }
}

export function createClientFromEnv(): GastownClient {
  const apiUrl = process.env.GASTOWN_API_URL;
  const sessionToken = process.env.GASTOWN_SESSION_TOKEN;
  const agentId = process.env.GASTOWN_AGENT_ID;
  const rigId = process.env.GASTOWN_RIG_ID;

  if (!apiUrl || !sessionToken || !agentId || !rigId) {
    const missing = [
      !apiUrl && 'GASTOWN_API_URL',
      !sessionToken && 'GASTOWN_SESSION_TOKEN',
      !agentId && 'GASTOWN_AGENT_ID',
      !rigId && 'GASTOWN_RIG_ID',
    ].filter(Boolean);
    throw new Error(`Missing required Gastown environment variables: ${missing.join(', ')}`);
  }

  return new GastownClient({ apiUrl, sessionToken, agentId, rigId });
}
