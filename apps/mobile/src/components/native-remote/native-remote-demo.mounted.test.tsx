import {
  button,
  flush,
  inventoryPending,
  mount,
  press,
  text,
  type,
} from './native-remote-test-utils';
import { type NativeInstanceReply } from '@kilocode/cloud-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@/test/renderer';
import { NativeRemoteDemo } from './native-remote-demo';
import {
  nativeRemoteFixture,
  onlineHost,
  readySession,
  summary,
} from './native-remote-test-helpers';

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
afterEach(() => {
  mocks.toastError.mockReset();
});

describe('native remote demo', () => {
  it('paginates creator sessions and refreshes live markers after presence updates', async () => {
    const fixture = nativeRemoteFixture();
    fixture.api.listSessions.mockResolvedValueOnce({ items: [summary], cursor: 'next' });
    const renderer = await mount(fixture.client);
    fixture.api.listSessions.mockResolvedValueOnce({
      items: [{ ...summary, sessionID: 'ses-second', live: false }],
      cursor: null,
    });
    await press(renderer, 'common.loadMore');
    expect(fixture.api.listSessions).toHaveBeenLastCalledWith('next');
    expect(text(renderer.root)).toContain('ses-first');
    expect(text(renderer.root)).toContain('ses-second');
    await act(async () => {
      fixture.publishPresence({ connection: 'connected', instances: [onlineHost] });
      await flush();
    });
    expect(fixture.api.listSessions).toHaveBeenLastCalledWith(undefined);
    expect(text(renderer.root)).toContain('Owned host');
  });

  it('connects presence in the selected organization and retires selections on a scope change', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client, 'org-owned');
    expect(fixture.api.connectPresence).toHaveBeenLastCalledWith(expect.any(Function), 'org-owned');
    await press(renderer, 'ses-first');
    const oldSession = fixture.connection('ses-first');
    await act(async () => {
      renderer.update(<NativeRemoteDemo client={fixture.client} organizationID="org-next" />);
      await flush();
    });
    expect(fixture.presence.close).toHaveBeenCalledOnce();
    expect(oldSession.close).toHaveBeenCalledOnce();
    expect(fixture.api.connectPresence).toHaveBeenLastCalledWith(expect.any(Function), 'org-next');
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'nativeRemote.prompt' })
    ).toHaveLength(0);
    await act(async () => {
      renderer.update(<NativeRemoteDemo client={fixture.client} />);
      await flush();
    });
    expect(fixture.api.connectPresence).toHaveBeenLastCalledWith(expect.any(Function), undefined);
  });

  it('creates on an online host using the uncontrolled directory field and opens its session', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await act(() => {
      fixture.publishPresence({ connection: 'connected', instances: [onlineHost] });
    });
    await press(renderer, 'Owned host');
    await type(renderer, 'nativeRemote.directory', '/owned/sample');
    await press(renderer, 'nativeRemote.createSession');
    expect(fixture.presence.command).toHaveBeenCalledExactlyOnceWith(
      'host-owned',
      'create_session',
      { directory: '/owned/sample' }
    );
    expect(fixture.api.connectSession).toHaveBeenCalledExactlyOnceWith(
      'ses-created',
      expect.any(Function),
      undefined
    );
  });

  it('renders snapshot/live updates, queues offline prompts and keeps clear local', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await press(renderer, 'ses-first');
    await act(() => {
      fixture.publishSession('ses-first', readySession);
    });
    expect(text(renderer.root)).toContain('Snapshot hello');
    await act(() => {
      fixture.publishSession('ses-first', {
        ...readySession,
        runnerConnected: false,
        messages: [
          {
            message: {
              id: 'msg_stream',
              type: 'assistant',
              time: { created: 2 },
              content: [{ type: 'text', text: 'Live delta' }],
            },
            seq: 2,
          },
        ],
      });
    });
    expect(text(renderer.root)).toContain('Live delta');
    await act(() => {
      const props = renderer.root.findByType('Switch').props as {
        onValueChange: (value: boolean) => void;
      };
      props.onValueChange(true);
    });
    await type(renderer, 'nativeRemote.prompt', 'Queued text');
    await press(renderer, 'common.sendMessage');
    const connection = fixture.connection('ses-first');
    expect(connection.sendMessage).toHaveBeenCalledExactlyOnceWith('Queued text', {
      queueIfOffline: true,
    });
    await type(renderer, 'nativeRemote.prompt', '/clear');
    await press(renderer, 'common.sendMessage');
    expect(connection.clear).toHaveBeenCalledOnce();
    expect(connection.sendCommand).not.toHaveBeenCalled();
    expect(connection.sendMessage).toHaveBeenCalledOnce();
  });

  it('answers attached pending permissions/questions, rejects questions, and aborts through the SDK', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await press(renderer, 'ses-first');
    await act(() => {
      fixture.publishSession('ses-first', { ...readySession, pending: inventoryPending() });
    });
    const connection = fixture.connection('ses-first');
    await press(renderer, 'agentChat.permissionCard.allowOnce');
    await press(renderer, 'agentChat.permissionCard.alwaysAllow');
    await press(renderer, 'agentChat.permissionCard.deny');
    expect(connection.respondPermission.mock.calls).toEqual([
      ['permission', 'once'],
      ['permission', 'always'],
      ['permission', 'reject'],
    ]);
    await type(renderer, 'Your choice', 'Proceed');
    await press(renderer, 'common.reply');
    expect(connection.replyQuestion).toHaveBeenCalledExactlyOnceWith('question', [['Proceed']]);
    await press(renderer, 'agentChat.questionCard.skip');
    expect(connection.rejectQuestion).toHaveBeenCalledExactlyOnceWith('question');
    await press(renderer, 'nativeRemote.abort');
    expect(connection.interrupt).toHaveBeenCalledOnce();
    await press(renderer, 'nativeRemote.localClear');
    expect(text(renderer.root)).toContain('Run tests');
  });

  it('toasts action failures and preserves the prompt for retry', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await press(renderer, 'ses-first');
    fixture.connection('ses-first').sendMessage.mockRejectedValueOnce(new Error('runner_offline'));
    await type(renderer, 'nativeRemote.prompt', 'Keep this');
    await press(renderer, 'common.sendMessage');
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('runner_offline');
    expect(button(renderer, 'common.sendMessage').props.disabled).toBe(false);
    await press(renderer, 'common.sendMessage');
    expect(fixture.connection('ses-first').sendMessage).toHaveBeenLastCalledWith('Keep this', {
      queueIfOffline: false,
    });
  });

  it('closes old client sockets and fences its late events and create reply', async () => {
    const old = nativeRemoteFixture();
    const next = nativeRemoteFixture();
    const renderer = await mount(old.client);
    await press(renderer, 'ses-first');
    const oldConnection = old.connection('ses-first');
    await act(() => {
      old.publishPresence({ connection: 'connected', instances: [onlineHost] });
    });
    await press(renderer, 'Owned host');
    const reply = Promise.withResolvers<NativeInstanceReply>();
    old.presence.command.mockReturnValueOnce(reply.promise);
    await press(renderer, 'nativeRemote.createSession');
    await act(async () => {
      renderer.update(<NativeRemoteDemo client={next.client} />);
      await flush();
    });
    expect(old.presence.close).toHaveBeenCalledOnce();
    expect(oldConnection.close).toHaveBeenCalledOnce();
    await act(async () => {
      old.publishSession('ses-first', readySession);
      old.publishPresence({ connection: 'connected', instances: [onlineHost] });
      reply.resolve({
        commandID: 'create',
        instanceID: 'host-owned',
        status: 'replied',
        body: { status: 'succeeded', result: { sessionID: 'ses-late' } },
      });
      await flush();
    });
    expect(next.api.connectSession).not.toHaveBeenCalled();
    expect(text(renderer.root)).not.toContain('Snapshot hello');
    expect(text(renderer.root)).not.toContain('ses-late');
  });
});
