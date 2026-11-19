import { mount, press, text } from './native-remote-test-utils';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { act } from '@/test/renderer';
import { nativeRemoteFixture, readySession } from './native-remote-test-helpers';

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const renderedMessageSchema = z.object({
  info: z.object({ id: z.string() }),
  parts: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
});

/** The marks the transcript puts around a displayed value, written as code points. */
const ISOLATE_OPEN = '\u2066';
const ISOLATE_CLOSE = '\u2069';
const FIRST_STRONG_OPEN = '\u2068';

it('reuses MessageBubble for files/tools/errors and keeps empty, incomplete and reset states distinct', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');
  await act(() => fixture.publishSession('ses-first', { ...readySession, messages: [] }));
  expect(text(renderer.root)).toContain('agentChat.session.emptyTitle');
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      messages: [
        {
          seq: 1,
          message: {
            id: 'msg_user',
            type: 'user',
            text: 'Read this',
            time: { created: 1 },
            files: [{ data: 'aW1hZ2U=', mime: 'image/png', source: { type: 'inline' } }],
          },
        },
        {
          seq: 2,
          message: {
            id: 'msg_answer',
            type: 'assistant',
            time: { created: 2 },
            cost: 2,
            error: { type: 'provider', message: 'Provider unavailable' },
            content: [
              {
                type: 'tool',
                id: 'call',
                name: 'shell',
                state: { status: 'running', input: { command: 'pwd' } },
              },
              { type: 'text', text: 'Answer' },
            ],
          },
        },
      ],
    })
  );
  const bubbles = renderer.root.findAllByType('MessageBubble');
  const messages = bubbles.map(node => renderedMessageSchema.parse(node.props.message));
  expect(messages.map(message => message.info.id)).toEqual(['msg_user', 'msg_answer']);
  expect(messages[0]?.parts[1]).toMatchObject({
    type: 'file',
    url: 'data:image/png;base64,aW1hZ2U=',
  });
  expect(bubbles[1]?.props).toMatchObject({
    retryAvailable: false,
    message: {
      info: { cost: 2, error: { data: { message: 'Provider unavailable' } } },
      parts: [
        { type: 'tool', tool: 'bash', state: { status: 'running' } },
        { type: 'text', text: 'Answer' },
      ],
    },
  });
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      connection: 'disconnected',
      runnerConnected: false,
      error: 'Native transcript replay reset required',
    })
  );
  expect(text(renderer.root)).toContain('Snapshot hello');
  expect(text(renderer.root)).toContain('Native transcript replay reset required');
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      messages: readySession.messages.map(item => ({ ...item, incomplete: true })),
    })
  );
  // A missing part reads as a localized gap banner, never as a raw id list.
  expect(text(renderer.root)).toContain('nativeRemote.recoveryGaps');
  expect(text(renderer.root)).toContain('common.retry');
  expect(text(renderer.root)).not.toContain('msg_snapshot');
  expect(text(renderer.root)).not.toContain('agentChat.session.emptyTitle');
  expect(renderer.root.findAllByType('MessageBubble')).toHaveLength(0);
});

it('counts missing transcript parts and clears the banner through Retry', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');
  const gap = (id: string, seq: number, complete = false) => ({
    seq,
    ...(complete ? {} : { incomplete: true }),
    message: {
      id,
      type: 'assistant' as const,
      time: { created: seq, ...(complete ? { completed: seq + 2 } : {}) },
      content: complete ? [{ type: 'text' as const, text: `Recovered ${id}` }] : [],
    },
  });
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      messages: [...readySession.messages, gap('msg_gap_a', 2), gap('msg_gap_b', 3)],
    })
  );
  const gaps = (node: { props: Record<string, unknown> }) =>
    node.props.accessibilityRole === 'alert' &&
    text(node as never).includes('nativeRemote.recoveryGaps');
  expect(renderer.root.findAll(gaps)).toHaveLength(1);
  expect(text(renderer.root)).toContain('Snapshot hello');
  expect(text(renderer.root)).not.toContain('msg_gap_a');
  const connection = fixture.connection('ses-first');
  await press(renderer, 'common.retry');
  expect(connection.requestRecovery).toHaveBeenCalledTimes(1);
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      messages: [...readySession.messages, gap('msg_gap_a', 2, true), gap('msg_gap_b', 3, true)],
    })
  );
  expect(text(renderer.root)).not.toContain('nativeRemote.recoveryGaps');
  expect(text(renderer.root)).toContain('Recovered msg_gap_a');
});

it('shows the loading skeleton while disconnected with no session', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');
  await act(() =>
    fixture.publishSession('ses-first', {
      connection: 'disconnected',
      runnerConnected: false,
      messages: [],
      pending: { permissions: [], questions: [], unreadablePermissions: [] },
      events: [],
      commands: {},
    })
  );
  // No snapshot has arrived, so the screen owes a progress skeleton, not a blank body.
  expect(renderer.root.findAllByType('Skeleton')).toHaveLength(1);
  expect(text(renderer.root)).not.toContain('nativeRemote.recoveryGaps');
  expect(text(renderer.root)).not.toContain('agentChat.session.emptyTitle');
});

it.each(['forbidden', 'session_deleted'])(
  'keeps %s distinct from an empty transcript',
  async failureCode => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await press(renderer, 'ses-first');
    await act(() =>
      fixture.publishSession('ses-first', {
        ...readySession,
        session: undefined,
        messages: [],
        connection: 'disconnected',
        error: failureCode,
      })
    );
    expect(text(renderer.root)).toContain(failureCode);
    expect(text(renderer.root)).not.toContain('agentChat.session.emptyTitle');
  }
);

it('opens native tool details through the shared host and keeps an open sheet live', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      messages: [
        {
          seq: 1,
          message: {
            id: 'msg_tool',
            type: 'assistant',
            time: { created: 1 },
            content: [
              {
                type: 'tool',
                id: 'call',
                name: 'shell',
                time: { created: 1, ran: 2 },
                state: { status: 'running', input: { command: 'pwd' } },
              },
            ],
          },
        },
      ],
    })
  );
  const row = renderer.root.findByType('MessageBubble');
  const tool = renderedMessageSchema.parse(row.props.message).parts[0];
  if (!tool) {
    throw new Error('Native tool was not projected');
  }
  await press(renderer, 'Open bash details');
  expect(renderer.root.findByType('PartDetailSheet').props).toMatchObject({
    visible: true,
    part: { id: tool.id, type: 'tool', state: { status: 'running', input: { command: 'pwd' } } },
  });
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      messages: [
        {
          seq: 1,
          message: {
            id: 'msg_tool',
            type: 'assistant',
            time: { created: 1, completed: 4 },
            content: [
              {
                type: 'tool',
                id: 'call',
                name: 'shell',
                time: { created: 1, ran: 2, completed: 3 },
                state: {
                  status: 'completed',
                  input: { command: 'pwd' },
                  content: [{ type: 'text', text: '/owned/project' }],
                },
              },
            ],
          },
        },
      ],
    })
  );
  expect(renderer.root.findByType('PartDetailSheet').props).toMatchObject({
    visible: true,
    part: {
      id: tool.id,
      state: { status: 'completed', input: { command: 'pwd' }, output: '/owned/project' },
    },
  });
});

it('shows one unreadable notice instead of consent controls and keeps readable cards', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');

  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      pending: {
        permissions: [],
        questions: [],
        unreadablePermissions: [{ requestId: 'perm-proof' }],
      },
    })
  );
  expect(text(renderer.root)).toContain('agentChat.permissionCard.unreadableTitle');
  expect(text(renderer.root)).not.toContain('agentChat.permissionCard.allowOnce');
  expect(
    renderer.root
      .findAllByType('Button')
      .map(node => text(node))
      .filter(label => label.startsWith('agentChat.permissionCard.'))
  ).toEqual([]);
  expect(renderer.root.findAll(node => node.props.accessibilityRole === 'alert')).toHaveLength(1);

  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      pending: { permissions: [], questions: [], unreadablePermissions: [] },
    })
  );
  expect(text(renderer.root)).not.toContain('agentChat.permissionCard.unreadableTitle');
  expect(renderer.root.findAll(node => node.props.accessibilityRole === 'alert')).toEqual([]);

  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      pending: {
        permissions: [{ id: 'perm-readable', action: 'shell', resources: ['Run tests'] }],
        questions: [],
        unreadablePermissions: [{ requestId: 'perm-proof' }],
      },
    })
  );
  const rendered = text(renderer.root);
  expect(rendered).toContain('agentChat.permissionCard.unreadableTitle');
  expect(rendered).toContain('shell');
  expect(rendered).toContain('Run tests');
  expect(rendered.indexOf('agentChat.permissionCard.unreadableTitle')).toBeLessThan(
    rendered.indexOf('agentChat.permissionCard.allowOnce')
  );
  expect(
    renderer.root
      .findAllByType('Button')
      .map(node => text(node))
      .filter(label => label.startsWith('agentChat.permissionCard.'))
  ).toEqual([
    'agentChat.permissionCard.allowOnce',
    'agentChat.permissionCard.alwaysAllow',
    'agentChat.permissionCard.deny',
  ]);
});

it('prints the permission action, resources and message as readable text', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      pending: {
        permissions: [
          {
            id: 'perm-bidi',
            action: 'shell\u202E',
            resources: ['/tmp/\u200Ex\nrm'],
            message: 'run\u0000it',
          },
        ],
        questions: [],
        unreadablePermissions: [],
      },
    })
  );
  const rendered = text(renderer.root);

  // A format character prints as the text that names it, and the marks around
  // each value keep its reading order on a right-to-left screen. The action and
  // the resources are pinned left to right; the message takes the direction of
  // its own first strong character, so an English message still reads left to
  // right and an Arabic one keeps its own.
  expect(rendered).toContain(`${ISOLATE_OPEN}shell\\u202e${ISOLATE_CLOSE}`);
  expect(rendered).toContain(`${ISOLATE_OPEN}/tmp/\\u200ex\\nrm${ISOLATE_CLOSE}`);
  expect(rendered).toContain(`${FIRST_STRONG_OPEN}run\\x00it${ISOLATE_CLOSE}`);
  expect(rendered).not.toContain(`${ISOLATE_OPEN}run\\x00it${ISOLATE_CLOSE}`);
  expect(rendered).toContain('• ');
  expect(rendered).not.toContain('shell\u202E');
  expect(rendered).not.toContain('/tmp/\u200Ex');
  expect(rendered).not.toContain('run\u0000it');
});
