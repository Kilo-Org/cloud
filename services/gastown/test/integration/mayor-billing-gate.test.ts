import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Integration tests: when container starts are blocked for a town, the
 * mayor-facing entry points must not warm or start the container and must
 * report the mayor as idle.
 */

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  const stub = env.TOWN.get(id);
  return stub;
}

type TownStub = ReturnType<typeof getTownStub>;

describe('Mayor paths while container starts are paused', () => {
  let town: TownStub;
  let townName: string;

  beforeEach(async () => {
    townName = `mayor-paused-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
    // The user-controlled run policy feeds the same start gate as the
    // billing state, without needing a meter binding in the test runtime.
    await town.setContainerRunPolicy('paused_by_user');
  });

  it('ensureMayor rejects while starts are paused', async () => {
    let error: unknown = null;
    try {
      await town.ensureMayor();
    } catch (err) {
      error = err;
    }
    expect(String(error)).toMatch(/paused/i);
  });

  it('sendMayorMessage rejects while starts are paused', async () => {
    let error: unknown = null;
    try {
      await town.sendMayorMessage('hello mayor');
    } catch (err) {
      error = err;
    }
    expect(String(error)).toMatch(/paused/i);
  });

  it('clears once the pause is lifted', async () => {
    await town.setContainerRunPolicy('automatic');
    const result = await town.sendMayorMessage('hello mayor');
    expect(result.agentId).toBeTruthy();
    // Prove the gate cleared: the dispatch attempt went all the way to
    // the container start (mock runtime accepts /agents/start), which the
    // paused tests above never reach.
    expect(result.sessionStatus).toBe('starting');
    const agent = await town.getAgentAsync(result.agentId);
    expect(agent?.status).toBe('working');
  });
});
