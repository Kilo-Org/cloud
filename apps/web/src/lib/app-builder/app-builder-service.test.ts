import { describe, expect, it } from '@jest/globals';
import {
  createProject,
  sendMessage,
  startSessionForProject,
} from '@/lib/app-builder/app-builder-service';

const owner = { type: 'user' as const, id: 'user-1' };

describe('App Builder kill switch', () => {
  it('refuses to create a project', async () => {
    await expect(
      createProject({
        owner,
        prompt: 'Build an app',
        model: 'test-model',
        createdByUserId: owner.id,
        authToken: 'token',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to start a prepared session', async () => {
    await expect(
      startSessionForProject({
        projectId: '00000000-0000-4000-8000-000000000001',
        owner,
        authToken: 'token',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to send a message', async () => {
    await expect(
      sendMessage({
        projectId: '00000000-0000-4000-8000-000000000001',
        owner,
        message: 'Hello',
        authToken: 'token',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
