import { readKilo2Messages } from './kilo2-source-messages';
import { buildToolDetail } from '@kilocode/app-shared/tool-detail';

const session = {
  id: 'ses_root',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
};
const notification = (state: string) => ({
  id: 'msg_agent_result',
  type: 'synthetic',
  time: { created: 3 },
  description: 'Inspect commands',
  metadata: { source: 'subagent', childID: 'ses_child', agent: 'explore', state },
  text: `<subagent sessionID="ses_child" state="${state}" description="Inspect commands">\n## Result\nChecked commands\n</subagent>`,
});

test.each([
  ['completed', 'finished'],
  ['error', 'failed'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
])('projects a %s subagent result', (state, outcome) => {
  const native = notification(state);
  const original = structuredClone(native);
  const display = readKilo2Messages(session, [native])[0];
  expect(display?.info.role).toBe('assistant');
  expect(display?.parts[0]).toMatchObject({
    tool: 'background_subagent_result',
    state: {
      metadata: {
        backgroundResult: {
          kind: 'subagent',
          childID: 'ses_child',
          outcome,
          output: '## Result\nChecked commands',
        },
      },
    },
  });
  if (outcome === 'failed') {
    const part = display?.parts[0];
    if (part?.type !== 'tool') throw new Error('Expected a background subagent tool part');
    expect(buildToolDetail(part)).toMatchObject({
      status: 'error',
      error: 'Explore failed\n\n## Result\nChecked commands',
    });
  }
  expect(native).toEqual(original);
});

test('user text and Cloud synthetic placeholders cannot impersonate a native result', () => {
  for (const source of ['callback', 'review', 'wakeup', 'queued', 'optimistic']) {
    const native = { ...notification('completed'), metadata: { source } };
    expect(readKilo2Messages(session, [native])[0]?.info.role).toBe('user');
  }
  expect(
    readKilo2Messages(session, [{ ...notification('completed'), type: 'user', synthetic: true }])[0]
      ?.info.role
  ).toBe('user');
});

test('unrecognized native notices have a neutral collapsed display classification', () => {
  const native = { ...notification('completed'), metadata: { source: 'future_native_notice' } };
  expect(readKilo2Messages(session, [native])[0]?.parts[0]).toMatchObject({
    tool: 'agent_notice',
    state: { metadata: { backgroundResult: { kind: 'notice', outcome: 'unknown' } } },
  });
});

test('native shell lifecycle records do not add a second result', () => {
  expect(
    readKilo2Messages(session, [
      { id: 'msg_shell_record', type: 'shell', time: { created: 2 }, shellID: 'sh_example' },
    ])
  ).toEqual([]);
});
