import { createScheduledController } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { CRONS } from '../src/schedule';
import { axiomOk, env, pageTexts, recordingFetch } from './helpers';

describe('scheduled handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pages and fails the run when the hourly checkpoint cannot be written', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const failingEnv = {
      ...env,
      AUDIT_ARCHIVE: {
        ...env.AUDIT_ARCHIVE,
        put: async () => {
          throw new Error('r2 unavailable');
        },
        head: async () => null,
      },
    };
    const controller = createScheduledController({
      scheduledTime: Date.UTC(2026, 10, 25, 7, 0, 0),
      cron: CRONS.hourlyCheckpoint,
    });

    await expect(worker.scheduled?.(controller, failingEnv)).rejects.toThrow('r2 unavailable');

    expect(pageTexts(http.requests)).toEqual([
      'bot: audit-relay could not write the hourly checkpoint (Error); the next hour retries',
    ]);
  });
});
