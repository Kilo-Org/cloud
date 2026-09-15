import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { GastownEnv } from '../gastown.worker';

const registry = vi.hoisted(() => ({
  listTowns: vi.fn(),
  getTownAsync: vi.fn(),
  getRigAsync: vi.fn(),
  listRigs: vi.fn(),
}));
vi.mock('../dos/GastownUser.do', () => ({ getGastownUserStub: vi.fn(() => registry) }));
vi.mock('../dos/Town.do', () => ({ getTownDOStub: vi.fn() }));
import { getGastownUserStub } from '../dos/GastownUser.do';
import {
  handleListTowns,
  handleGetTown,
  handleGetRig,
  handleListRigs,
  handleCreateTown,
  handleCreateRig,
  handleDeleteTown,
  handleDeleteRig,
} from './towns.handler';

describe('personal registry inspection versus mutation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    registry.listTowns.mockResolvedValue([]);
    registry.listRigs.mockResolvedValue([]);
    registry.getTownAsync.mockResolvedValue({ id: 'town' });
    registry.getRigAsync.mockResolvedValue({ id: 'rig' });
  });
  const reads = [handleListTowns, handleGetTown, handleGetRig, handleListRigs];
  it.each(reads)('allows admin inspection through %s', async handler => {
    const app = new Hono<GastownEnv>();
    app.get('/', c => {
      c.set('kiloUserId', 'admin');
      c.set('kiloIsAdmin', true);
      return handler(c, { userId: 'owner', townId: 'town', rigId: 'rig' });
    });
    expect((await app.request('/', {}, {} as Env)).status).toBe(200);
    expect(getGastownUserStub).toHaveBeenCalledWith(expect.anything(), 'owner');
  });
  it.each(reads)('rejects unrelated non-admin inspection through %s', async handler => {
    const app = new Hono<GastownEnv>();
    app.get('/', c => {
      c.set('kiloUserId', 'other');
      c.set('kiloIsAdmin', false);
      return handler(c, { userId: 'owner', townId: 'town', rigId: 'rig' });
    });
    expect((await app.request('/', {}, {} as Env)).status).toBe(403);
    expect(getGastownUserStub).not.toHaveBeenCalled();
  });
  it.each([handleCreateTown, handleCreateRig, handleDeleteTown, handleDeleteRig])(
    'does not grant cross-owner admin mutation through %s',
    async handler => {
      const app = new Hono<GastownEnv>();
      app.post('/', c => {
        c.set('kiloUserId', 'admin');
        c.set('kiloIsAdmin', true);
        return handler(c, { userId: 'owner', townId: 'town', rigId: 'rig' });
      });
      expect((await app.request('/', { method: 'POST' })).status).toBe(403);
      expect(getGastownUserStub).not.toHaveBeenCalled();
    }
  );
});
