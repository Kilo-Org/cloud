import { mount, press, text } from './native-remote-test-utils';
import { expect, it, vi } from 'vitest';
import { act } from '@/test/renderer';
import { nativeRemoteFixture, readySession } from './native-remote.test-helpers';

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

/** The gap states: a missing part reads as a localized count, never raw ids. */
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

it('keeps the retry out of reach while the session cannot run recovery', async () => {
  const fixture = nativeRemoteFixture();
  const renderer = await mount(fixture.client);
  await press(renderer, 'ses-first');
  const gap = (id: string, seq: number) => ({
    seq,
    incomplete: true,
    message: { id, type: 'assistant' as const, time: { created: seq }, content: [] },
  });
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      connection: 'disconnected' as const,
      messages: [...readySession.messages, gap('msg_gap_a', 2)],
    })
  );
  const retry = renderer.root
    .findAllByType('Button')
    .filter((node: { props: Record<string, unknown> }) => text(node as never) === 'common.retry');
  expect(retry).toHaveLength(1);
  // Recovery reads the snapshot over the socket, so only the relay outage
  // disables it; a runner restart keeps the action runnable.
  expect(retry[0]?.props.disabled).toBe(true);
  await act(() =>
    fixture.publishSession('ses-first', {
      ...readySession,
      connection: 'connected' as const,
      runnerConnected: false,
      messages: [...readySession.messages, gap('msg_gap_a', 2)],
    })
  );
  expect(
    renderer.root
      .findAllByType('Button')
      .find((node: { props: Record<string, unknown> }) => text(node as never) === 'common.retry')
      ?.props.disabled
  ).toBe(false);
});
