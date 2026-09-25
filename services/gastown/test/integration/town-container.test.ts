import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...extra,
  };
}

function api(path: string): string {
  return `http://localhost${path}`;
}

describe('Town Container Routes', () => {
  const townId = () => `town-${crypto.randomUUID()}`;

  // ── Container start agent route ─────────────────────────────────────────

  describe('POST /agents/start', () => {
    it('should reject start-agent without body', async () => {
      const id = townId();
      const res = await SELF.fetch(api(`/api/towns/${id}/container/agents/start`), {
        method: 'POST',
        headers: headers(),
      });
      // Should get 400 (invalid body) rather than 401
      expect(res.status).toBe(400);
    });
  });

  // ── Container message route ─────────────────────────────────────────────

  describe('POST /agents/:agentId/message', () => {
    it('should reject message without body', async () => {
      const id = townId();
      const res = await SELF.fetch(api(`/api/towns/${id}/container/agents/some-agent/message`), {
        method: 'POST',
        headers: headers(),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('Heartbeat Endpoint', () => {
  const rigId = () => `rig-${crypto.randomUUID()}`;

  it('should update agent activity via heartbeat', async () => {
    const id = rigId();

    // Register an agent first
    const createRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ role: 'polecat', name: 'test-polecat', identity: 'polecat-1' }),
    });
    expect(createRes.status).toBe(201);
    const createBody: { data: { id: string; last_activity_at: string } } = await createRes.json();
    const agentId = createBody.data.id;
    const oldActivity = createBody.data.last_activity_at;

    // Wait a tiny bit to ensure timestamp changes
    await new Promise(r => setTimeout(r, 10));

    // Send heartbeat
    const heartbeatRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${agentId}/heartbeat`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ status: 'running' }),
    });
    expect(heartbeatRes.status).toBe(200);
    const heartbeatBody: { success: boolean; data: { heartbeat: boolean } } =
      await heartbeatRes.json();
    expect(heartbeatBody.success).toBe(true);
    expect(heartbeatBody.data.heartbeat).toBe(true);

    // Verify agent's activity was updated
    const getRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${agentId}`), {
      headers: headers(),
    });
    const getBody: { data: { last_activity_at: string } } = await getRes.json();
    expect(getBody.data.last_activity_at).not.toBe(oldActivity);
  });

  it('should handle heartbeat for non-existent agent gracefully', async () => {
    const id = rigId();
    const res = await SELF.fetch(api(`/api/rigs/${id}/agents/non-existent/heartbeat`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ status: 'running' }),
    });
    // The DO's touchAgent won't throw for non-existent agent (it's a no-op UPDATE)
    expect(res.status).toBe(200);
  });
});

describe('Town DO — touchAgentHeartbeat', () => {
  it('should update agent last_activity_at via RPC', async () => {
    const id = `town-${crypto.randomUUID()}`;
    const town = env.TOWN.get(env.TOWN.idFromName(id));

    // Register agent
    const agent = await town.registerAgent({
      role: 'polecat',
      name: 'heartbeat-test',
      identity: 'hb-test-1',
    });

    const initialActivity = agent.last_activity_at;
    await new Promise(r => setTimeout(r, 10));

    // Touch via heartbeat
    await town.touchAgentHeartbeat(agent.id);

    // Verify updated
    const updated = await town.getAgentAsync(agent.id);
    expect(updated).not.toBeNull();
    expect(updated!.last_activity_at).not.toBe(initialActivity);
  });
});
