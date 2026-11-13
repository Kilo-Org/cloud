import { expect, test } from 'bun:test';
import { readKilo2BackgroundActivity } from './kilo2-background.js';
import type { Kilo2Api } from './kilo2-api.js';
import type { BackgroundJob } from '@kilocode/session-ingest-contracts';

const shell = {
  kind: 'shell',
  id: 'job_shell',
  sessionID: 'ses_child',
  shellID: 'sh_child',
  command: 'sleep 1',
  status: 'running',
  time: { started: 1 },
} satisfies BackgroundJob;
const agent = {
  kind: 'subagent',
  id: 'job_agent',
  sessionID: 'ses_root',
  childSessionID: 'ses_child',
  agent: 'explore',
  description: 'Inspect commands',
  status: 'running',
  time: { started: 1 },
} satisfies BackgroundJob;

async function errorMessage(result: Promise<unknown>) {
  try {
    await result;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
function apiFor(jobs: unknown[], parentID = 'ses_root'): Kilo2Api {
  return {
    request: async () => {
      throw new Error('Unexpected session enumeration');
    },
    data: async path => {
      if (path.startsWith('/api/experimental/job?')) {
        const query = new URL(path, 'http://localhost').searchParams;
        expect(Object.fromEntries(query)).toEqual({
          sessionID: 'ses_root',
          descendants: 'true',
          status: 'running',
        });
        return jobs;
      }
      if (path.startsWith('/api/form?'))
        return [{ id: 'form_child', sessionID: 'ses_child', title: 'Choose', fields: [] }];
      if (path.startsWith('/api/permission/request?'))
        return [
          {
            id: 'permission_sibling',
            sessionID: 'ses_sibling',
            action: 'shell',
            resources: [],
            save: [],
          },
        ];
      const id = path.split('/').at(-1);
      return {
        id,
        ...(id === 'ses_child' ? { parentID } : {}),
        location: { directory: '/workspace/app' },
        time: { created: 1, updated: 2 },
      };
    },
  };
}

test('reads the pinned inventory, includes descendant work and excludes sibling waits', async () => {
  const result = await readKilo2BackgroundActivity(
    apiFor([shell, agent, { kind: 'image' }]),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result.jobs).toEqual([shell, agent]);
  expect(result.waits).toEqual([{ sessionID: 'ses_child', kind: 'question' }]);
  expect(result.sessions.map(session => session.id)).toEqual(['ses_root', 'ses_child']);
});

test('rejects sibling inventory even if the native filter returns it', async () => {
  expect(
    await errorMessage(
      readKilo2BackgroundActivity(
        apiFor([{ ...shell, sessionID: 'ses_sibling' }]),
        'ses_root',
        '/workspace/app',
        new AbortController().signal
      )
    )
  ).toContain('another chat');
});

test('rejects an agent whose child does not belong to its owning chat', async () => {
  expect(
    await errorMessage(
      readKilo2BackgroundActivity(
        apiFor([agent], 'ses_sibling'),
        'ses_root',
        '/workspace/app',
        new AbortController().signal
      )
    )
  ).toContain('lineage mismatch');
});

test('does not turn a failed native read into an empty inventory', async () => {
  const api = apiFor([]);
  api.data = async () => {
    throw new Error('runtime unavailable');
  };
  expect(
    await errorMessage(
      readKilo2BackgroundActivity(api, 'ses_root', '/workspace/app', new AbortController().signal)
    )
  ).toContain('runtime unavailable');
});
