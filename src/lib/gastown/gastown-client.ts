import 'server-only';
import {
  GASTOWN_SERVICE_URL,
  GASTOWN_CF_ACCESS_CLIENT_ID,
  GASTOWN_CF_ACCESS_CLIENT_SECRET,
} from '@/lib/config.server';
import { z } from 'zod';

// ── Response schemas ──────────────────────────────────────────────────────

const GastownErrorResponse = z.object({
  success: z.literal(false),
  error: z.string(),
});

// ── Domain schemas ────────────────────────────────────────────────────────
// Mirror the gastown worker's record schemas for validation at the IO boundary.

export const TownSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Town = z.output<typeof TownSchema>;

export const RigSchema = z.object({
  id: z.string(),
  town_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Rig = z.output<typeof RigSchema>;

export const BeadSchema = z.object({
  id: z.string(),
  type: z.enum(['issue', 'message', 'escalation', 'merge_request']),
  status: z.enum(['open', 'in_progress', 'closed', 'failed']),
  title: z.string(),
  body: z.string().nullable(),
  assignee_agent_id: z.string().nullable(),
  convoy_id: z.string().nullable(),
  molecule_id: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  labels: z.union([
    z.array(z.string()),
    z
      .string()
      .transform(v => JSON.parse(v))
      .pipe(z.array(z.string())),
  ]),
  metadata: z.union([
    z.record(z.string(), z.unknown()),
    z
      .string()
      .transform(v => JSON.parse(v))
      .pipe(z.record(z.string(), z.unknown())),
  ]),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});
export type Bead = z.output<typeof BeadSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  role: z.enum(['polecat', 'refinery', 'mayor', 'witness']),
  name: z.string(),
  identity: z.string(),
  status: z.enum(['idle', 'working', 'blocked', 'dead']),
  current_hook_bead_id: z.string().nullable(),
  dispatch_attempts: z.number().default(0),
  last_activity_at: z.string(),
  checkpoint: z.string().nullable(),
  created_at: z.string(),
});
export type Agent = z.output<typeof AgentSchema>;

export const StreamTicketSchema = z.object({
  url: z.string(),
  ticket: z.string().optional(),
});
export type StreamTicket = z.output<typeof StreamTicketSchema>;

// ── Client ────────────────────────────────────────────────────────────────

export class GastownApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'GastownApiError';
  }
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (GASTOWN_CF_ACCESS_CLIENT_ID && GASTOWN_CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = GASTOWN_CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = GASTOWN_CF_ACCESS_CLIENT_SECRET;
  }

  return headers;
}

const CLIENT_LOG = '[gastown-client]';

async function gastownFetch(path: string, init?: RequestInit): Promise<unknown> {
  if (!GASTOWN_SERVICE_URL) {
    console.error(`${CLIENT_LOG} GASTOWN_SERVICE_URL is not configured!`);
    throw new GastownApiError('GASTOWN_SERVICE_URL is not configured', 500);
  }

  const url = `${GASTOWN_SERVICE_URL}${path}`;
  const method = init?.method ?? 'GET';
  console.log(`${CLIENT_LOG} ${method} ${url}`);
  if (init?.body) {
    console.log(
      `${CLIENT_LOG}   body: ${typeof init.body === 'string' ? init.body.slice(0, 500) : '[non-string body]'}`
    );
  }

  const startTime = Date.now();
  const response = await fetch(url, {
    ...init,
    headers: { ...getHeaders(), ...init?.headers },
  });
  const elapsed = Date.now() - startTime;

  console.log(`${CLIENT_LOG} ${method} ${path} -> ${response.status} (${elapsed}ms)`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.error(`${CLIENT_LOG} Non-JSON response from ${path}: status=${response.status}`);
    throw new GastownApiError(
      `Gastown returned non-JSON response (${response.status})`,
      response.status
    );
  }

  if (!response.ok) {
    const parsed = GastownErrorResponse.safeParse(body);
    const message = parsed.success ? parsed.data.error : `Gastown API error (${response.status})`;
    console.error(`${CLIENT_LOG} Error from ${path}: ${response.status} - ${message}`);
    console.error(`${CLIENT_LOG}   Response body: ${JSON.stringify(body).slice(0, 500)}`);
    throw new GastownApiError(message, response.status);
  }

  console.log(`${CLIENT_LOG} ${method} ${path} response: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function parseSuccessData<T>(body: unknown, schema: z.ZodType<T>): T {
  const envelope = z.object({ success: z.literal(true), data: schema }).parse(body);
  return envelope.data;
}

// ── Town operations ───────────────────────────────────────────────────────

export async function createTown(userId: string, name: string): Promise<Town> {
  const body = await gastownFetch(`/api/users/${userId}/towns`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return parseSuccessData(body, TownSchema);
}

export async function listTowns(userId: string): Promise<Town[]> {
  const body = await gastownFetch(`/api/users/${userId}/towns`);
  return parseSuccessData(body, TownSchema.array());
}

export async function getTown(userId: string, townId: string): Promise<Town> {
  const body = await gastownFetch(`/api/users/${userId}/towns/${townId}`);
  return parseSuccessData(body, TownSchema);
}

// ── Rig operations ────────────────────────────────────────────────────────

export async function createRig(
  userId: string,
  input: {
    town_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    kilocode_token?: string;
  }
): Promise<Rig> {
  const body = await gastownFetch(`/api/users/${userId}/rigs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, RigSchema);
}

export async function getRig(userId: string, rigId: string): Promise<Rig> {
  const body = await gastownFetch(`/api/users/${userId}/rigs/${rigId}`);
  return parseSuccessData(body, RigSchema);
}

export async function listRigs(userId: string, townId: string): Promise<Rig[]> {
  const body = await gastownFetch(`/api/users/${userId}/towns/${townId}/rigs`);
  return parseSuccessData(body, RigSchema.array());
}

// ── Bead operations (via Rig DO) ──────────────────────────────────────────

export async function createBead(
  rigId: string,
  input: {
    type: string;
    title: string;
    body?: string;
    priority?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
    assignee_agent_id?: string;
  }
): Promise<Bead> {
  const body = await gastownFetch(`/api/rigs/${rigId}/beads`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, BeadSchema);
}

const SlingResultSchema = z.object({
  bead: BeadSchema,
  agent: AgentSchema,
});
export type SlingResult = z.output<typeof SlingResultSchema>;

export async function slingBead(
  rigId: string,
  input: { title: string; body?: string; metadata?: Record<string, unknown> }
): Promise<SlingResult> {
  const body = await gastownFetch(`/api/rigs/${rigId}/sling`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, SlingResultSchema);
}

export async function listBeads(rigId: string, filter?: { status?: string }): Promise<Bead[]> {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  const qs = params.toString();
  const path = `/api/rigs/${rigId}/beads${qs ? `?${qs}` : ''}`;
  const body = await gastownFetch(path);
  return parseSuccessData(body, BeadSchema.array());
}

// ── Agent operations (via Rig DO) ─────────────────────────────────────────

export async function registerAgent(
  rigId: string,
  input: { role: string; name: string; identity: string }
): Promise<Agent> {
  const body = await gastownFetch(`/api/rigs/${rigId}/agents`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, AgentSchema);
}

export async function listAgents(rigId: string): Promise<Agent[]> {
  const body = await gastownFetch(`/api/rigs/${rigId}/agents`);
  return parseSuccessData(body, AgentSchema.array());
}

export async function getOrCreateAgent(rigId: string, role: string): Promise<Agent> {
  const body = await gastownFetch(`/api/rigs/${rigId}/agents/get-or-create`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  });
  return parseSuccessData(body, AgentSchema);
}

export async function hookBead(rigId: string, agentId: string, beadId: string): Promise<void> {
  await gastownFetch(`/api/rigs/${rigId}/agents/${agentId}/hook`, {
    method: 'POST',
    body: JSON.stringify({ bead_id: beadId }),
  });
}

// ── Delete operations ──────────────────────────────────────────────────────

export async function deleteTown(userId: string, townId: string): Promise<void> {
  await gastownFetch(`/api/users/${userId}/towns/${townId}`, { method: 'DELETE' });
}

export async function deleteRig(userId: string, rigId: string): Promise<void> {
  await gastownFetch(`/api/users/${userId}/rigs/${rigId}`, { method: 'DELETE' });
}

export async function deleteBead(rigId: string, beadId: string): Promise<void> {
  await gastownFetch(`/api/rigs/${rigId}/beads/${beadId}`, { method: 'DELETE' });
}

export async function deleteAgent(rigId: string, agentId: string): Promise<void> {
  await gastownFetch(`/api/rigs/${rigId}/agents/${agentId}`, { method: 'DELETE' });
}

// ── Container operations (via Town Container DO) ──────────────────────────

export async function getStreamTicket(townId: string, agentId: string): Promise<StreamTicket> {
  const body = await gastownFetch(
    `/api/towns/${townId}/container/agents/${agentId}/stream-ticket`,
    { method: 'POST' }
  );
  return parseSuccessData(body, StreamTicketSchema);
}
