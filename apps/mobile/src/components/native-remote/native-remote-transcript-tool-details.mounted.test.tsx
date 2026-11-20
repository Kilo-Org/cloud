import { mount, press } from './native-remote-test-utils';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { act } from '@/test/renderer';
import { nativeRemoteFixture, readySession } from './native-remote.test-helpers';

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const renderedMessageSchema = z.object({
  info: z.object({ id: z.string() }),
  parts: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
});

it('routes a transcript tool row into the shared host and keeps an open sheet live', async () => {
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
