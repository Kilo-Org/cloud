import { expect, test } from 'bun:test';
import { readKilo2BackgroundActivity } from './kilo2-background.js';
import type { Kilo2Api } from './kilo2-api.js';
import type { BackgroundJob } from '../../../src/shared/background-activity.js';

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
function apiFor(
  jobs: unknown[],
  parentID = 'ses_root',
  shells: unknown[] = jobs.flatMap(job =>
    job && typeof job === 'object' && 'shellID' in job
      ? [{ id: job.shellID, status: 'running' }]
      : []
  )
): Kilo2Api {
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
      if (path.startsWith('/api/shell?')) {
        const query = new URL(path, 'http://localhost').searchParams;
        expect(query.get('location[directory]')).toBe('/workspace/app');
        return shells;
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

test('only reports shell jobs that still have a running shell in the current runtime', async () => {
  const live = { ...shell, id: 'job_live', shellID: 'sh_live' };
  const exited = { ...shell, id: 'job_exited', shellID: 'sh_exited' };
  const result = await readKilo2BackgroundActivity(
    apiFor([shell, live, exited, agent], 'ses_root', [
      { id: live.shellID, status: 'running' },
      { id: exited.shellID, status: 'exited' },
      { id: 'sh_unrelated', status: 'running' },
    ]),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result.jobs).toEqual([live, agent]);
});

test('drops sibling inventory even if the native filter returns it', async () => {
  const result = await readKilo2BackgroundActivity(
    apiFor([{ ...shell, sessionID: 'ses_sibling' }, agent]),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result.jobs).toEqual([agent]);
  expect(result.sessions.map(session => session.id)).not.toContain('ses_sibling');
});

test('keeps subagents and waits when the shell inventory read fails', async () => {
  const api = apiFor([shell, agent]);
  const data = api.data;
  api.data = async (path, options) => {
    if (path.startsWith('/api/shell?')) throw new Error('shell inventory unavailable');
    return data(path, options);
  };
  const result = await readKilo2BackgroundActivity(
    api,
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result.jobs).toEqual([agent]);
  expect(result.waits).toEqual([{ sessionID: 'ses_child', kind: 'question' }]);
});

test('propagates caller cancellation during the shell inventory read', async () => {
  const api = apiFor([shell, agent]);
  const controller = new AbortController();
  const cancelled = new Error('background read cancelled');
  const data = api.data;
  api.data = async (path, options) => {
    if (path.startsWith('/api/shell?')) {
      controller.abort(cancelled);
      throw cancelled;
    }
    return data(path, options);
  };
  expect(
    await readKilo2BackgroundActivity(api, 'ses_root', '/workspace/app', controller.signal).catch(
      (error: unknown) => error
    )
  ).toBe(cancelled);
});

test('drops an agent whose child does not belong to its owning chat', async () => {
  const result = await readKilo2BackgroundActivity(
    apiFor([agent, { ...shell, sessionID: 'ses_root' }], 'ses_sibling'),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result.jobs).toEqual([{ ...shell, sessionID: 'ses_root' }]);
});

test('skips unreadable job kinds and truncates a large inventory', async () => {
  const many = Array.from({ length: 300 }, (_, index) => ({
    ...shell,
    id: `job_${index}`,
    shellID: `sh_${index}`,
  }));
  const result = await readKilo2BackgroundActivity(
    apiFor([{ kind: 'future_kind', id: 'job_future' }, shell, ...many]),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result.jobs[0]).toEqual(shell);
  expect(result.jobs).toHaveLength(256);
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
