import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdateTownConfig } from './town-config.handler';
import type { GastownEnv } from '../gastown.worker';

const town = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
}));

vi.mock('../dos/Town.do', async () => {
  const { TownConfigSchema: Schema } = await import('../types');
  return {
    getTownDOStub: () => ({
      async getTownConfig() {
        return Schema.parse({ owner_user_id: 'user-owner' });
      },
      async updateTownConfig(update: Record<string, unknown>) {
        town.updates.push(update);
        return Schema.parse({ owner_user_id: 'user-owner' });
      },
      async updateMayorSystemPrompt() {},
    }),
  };
});

function restApp() {
  const app = new Hono<GastownEnv>();
  app.patch('/api/towns/:townId/config', c => handleUpdateTownConfig(c, c.req.param()));
  return app;
}

describe('handleUpdateTownConfig', () => {
  beforeEach(() => {
    town.updates.length = 0;
  });

  it('does not let a config update change town ownership', async () => {
    const response = await restApp().request(
      '/api/towns/11111111-2222-4333-8444-555555555555/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_type: 'org',
          owner_id: 'org-other',
          owner_user_id: 'user-other',
          organization_id: 'org-other',
          created_by_user_id: 'user-other',
          default_model: 'kilo/test-model',
        }),
      },
      {} as Env
    );

    expect(response.status).toBe(200);
    expect(town.updates).toHaveLength(1);
    const update = town.updates[0];
    for (const field of [
      'owner_type',
      'owner_id',
      'owner_user_id',
      'organization_id',
      'created_by_user_id',
    ]) {
      expect(update).not.toHaveProperty(field);
    }
    expect(update).toMatchObject({ default_model: 'kilo/test-model' });
  });
});
