import type {
  Agent,
  ApiResponse,
  Bead,
  BeadPriority,
  BeadStatus,
  BeadType,
  GastownEnv,
  Mail,
  MayorGastownEnv,
  PrimeContext,
  Rig,
  SlingResult,
} from './types';

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
    // Normalize headers so callers can pass plain objects, Headers instances, or tuples
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${this.token}`);

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GastownApiError(`Network error: ${message}`, 0);
    }

    // 204 No Content — nothing to parse, return early
    if (response.status === 204) {
      return undefined as T;
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

  async getMoleculeCurrentStep(): Promise<{
    moleculeId: string;
    currentStep: number;
    totalSteps: number;
    step: { title: string; instructions: string };
    status: string;
  } | null> {
    try {
      return await this.request(this.rigPath(`/agents/${this.agentId}/molecule/current`));
    } catch (err) {
      if (err instanceof GastownApiError && err.status === 404) return null;
      throw err;
    }
  }

  async advanceMoleculeStep(summary: string): Promise<{
    moleculeId: string;
    previousStep: number;
    currentStep: number;
    totalSteps: number;
    completed: boolean;
  }> {
    return this.request(this.rigPath(`/agents/${this.agentId}/molecule/advance`), {
      method: 'POST',
      body: JSON.stringify({ summary }),
    });
  }
}

/**
 * Mayor-scoped client for town-level cross-rig operations.
 * Uses `/api/mayor/:townId/tools/*` routes authenticated via townId-scoped JWT.
 */
export class MayorGastownClient {
  private baseUrl: string;
  private token: string;
  private agentId: string;
  private townId: string;

  constructor(env: MayorGastownEnv) {
    this.baseUrl = env.apiUrl.replace(/\/+$/, '');
    this.token = env.sessionToken;
    this.agentId = env.agentId;
    this.townId = env.townId;
  }

  private mayorPath(path: string): string {
    return `${this.baseUrl}/api/mayor/${this.townId}/tools${path}`;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${this.token}`);

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GastownApiError(`Network error: ${message}`, 0);
    }

    if (response.status === 204) {
      return undefined as T;
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

  // -- Mayor tool endpoints --

  async sling(input: {
    rig_id: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SlingResult> {
    return this.request<SlingResult>(this.mayorPath('/sling'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listRigs(): Promise<Rig[]> {
    return this.request<Rig[]>(this.mayorPath('/rigs'));
  }

  async listBeads(
    rigId: string,
    filter?: { status?: BeadStatus; type?: BeadType }
  ): Promise<Bead[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.type) params.set('type', filter.type);
    const qs = params.toString();
    return this.request<Bead[]>(this.mayorPath(`/rigs/${rigId}/beads${qs ? `?${qs}` : ''}`));
  }

  async listAgents(rigId: string): Promise<Agent[]> {
    return this.request<Agent[]>(this.mayorPath(`/rigs/${rigId}/agents`));
  }

  async sendMail(input: {
    rig_id: string;
    to_agent_id: string;
    subject: string;
    body: string;
  }): Promise<void> {
    await this.request<void>(this.mayorPath('/mail'), {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        from_agent_id: this.agentId,
      }),
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

export function createMayorClientFromEnv(): MayorGastownClient {
  const apiUrl = process.env.GASTOWN_API_URL;
  const sessionToken = process.env.GASTOWN_SESSION_TOKEN;
  const agentId = process.env.GASTOWN_AGENT_ID;
  const townId = process.env.GASTOWN_TOWN_ID;

  if (!apiUrl || !sessionToken || !agentId || !townId) {
    const missing = [
      !apiUrl && 'GASTOWN_API_URL',
      !sessionToken && 'GASTOWN_SESSION_TOKEN',
      !agentId && 'GASTOWN_AGENT_ID',
      !townId && 'GASTOWN_TOWN_ID',
    ].filter(Boolean);
    throw new Error(`Missing required mayor environment variables: ${missing.join(', ')}`);
  }

  return new MayorGastownClient({ apiUrl, sessionToken, agentId, townId });
}
