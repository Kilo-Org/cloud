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
  expect(text(renderer.root)).toContain('Native transcript recovery is incomplete');
  expect(text(renderer.root)).not.toContain('agentChat.session.emptyTitle');
  expect(renderer.root.findAllByType('MessageBubble')).toHaveLength(0);
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
