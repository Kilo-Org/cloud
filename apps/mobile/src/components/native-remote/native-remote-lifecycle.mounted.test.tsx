import { flush, inventoryPending, mount, press, text, type } from './native-remote-test-utils';
import { type NativeInstanceReply, type NativeSessionSummary } from '@kilocode/cloud-agent-sdk';
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

describe('native remote lifecycle fencing', () => {
  it('closes a replaced session and ignores its late action failure and snapshot', async () => {
    const fixture = nativeRemoteFixture();
    fixture.api.listSessions.mockResolvedValue({
      items: [summary, { ...summary, sessionID: 'ses-second' }],
      cursor: null,
    });
    const renderer = await mount(fixture.client);
    await press(renderer, 'ses-first');
    const old = fixture.connection('ses-first');
    const pending = Promise.withResolvers<string>();
    old.sendMessage.mockReturnValueOnce(pending.promise);
    await type(renderer, 'nativeRemote.prompt', 'Old draft');
    await press(renderer, 'common.sendMessage');
    await press(renderer, 'ses-second');
    expect(old.close).toHaveBeenCalledOnce();
    await act(async () => {
      fixture.publishSession('ses-second', {
        ...readySession,
        messages: [
          {
            message: {
              id: 'msg_new',
              type: 'assistant',
              time: { created: 1 },
              content: [{ type: 'text', text: 'New session' }],
            },
            seq: 1,
          },
        ],
      });
      fixture.publishSession('ses-first', readySession);
      pending.reject(new Error('Late error'));
      await flush();
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain('New session');
    expect(text(renderer.root)).not.toContain('Snapshot hello');
    expect(text(renderer.root)).not.toContain('Late error');
  });

  it('does not override a manual session selection with a late create_session reply', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await act(() => {
      fixture.publishPresence({ connection: 'connected', instances: [onlineHost] });
    });
    await press(renderer, 'Owned host');
    const pending = Promise.withResolvers<NativeInstanceReply>();
    fixture.presence.command.mockReturnValueOnce(pending.promise);
    await press(renderer, 'nativeRemote.createSession');
    await press(renderer, 'ses-first');
    await act(async () => {
      pending.resolve({
        commandID: 'create',
        instanceID: 'host-owned',
        status: 'replied',
        body: { status: 'succeeded', result: { sessionID: 'ses-late' } },
      });
      await flush();
    });
    expect(fixture.api.connectSession).toHaveBeenCalledExactlyOnceWith(
      'ses-first',
      expect.any(Function),
      undefined
    );
  });

  it('ignores an old client listing after the replacement client has loaded', async () => {
    const old = nativeRemoteFixture();
    const next = nativeRemoteFixture();
    const pending = Promise.withResolvers<{ items: NativeSessionSummary[]; cursor: null }>();
    old.api.listSessions.mockReturnValueOnce(pending.promise);
    next.api.listSessions.mockResolvedValue({
      items: [{ ...summary, sessionID: 'ses-new-owner' }],
      cursor: null,
    });
    const renderer = await mount(old.client);
    await act(async () => {
      renderer.update(<NativeRemoteDemo client={next.client} />);
      await flush();
    });
    await act(async () => {
      pending.resolve({ items: [{ ...summary, sessionID: 'ses-old-owner' }], cursor: null });
      await flush();
    });
    expect(text(renderer.root)).toContain('ses-new-owner');
    expect(text(renderer.root)).not.toContain('ses-old-owner');
    expect(old.presence.close).toHaveBeenCalledOnce();
  });

  it('sends selected multiselect options and custom answers with the original field order', async () => {
    const fixture = nativeRemoteFixture();
    const renderer = await mount(fixture.client);
    await press(renderer, 'ses-first');
    await act(() => {
      fixture.publishSession('ses-first', {
        ...readySession,
        pending: {
          ...inventoryPending(),
          questions: [
            {
              id: 'question',
              metadata: { kind: 'question' },
              fields: [
                {
                  key: 'choices',
                  type: 'multiselect',
                  title: 'Options',
                  custom: true,
                  options: [
                    { value: 'first', label: 'First option' },
                    { value: 'second', label: 'Second option' },
                  ],
                },
                { key: 'details', type: 'text', title: 'Details' },
              ],
            },
          ],
        },
      });
    });
    await press(renderer, 'First option');
    await press(renderer, 'Second option');
    await type(renderer, 'Options', 'custom');
    await type(renderer, 'Details', 'detail answer');
    await press(renderer, 'common.reply');
    expect(fixture.connection('ses-first').replyQuestion).toHaveBeenCalledExactlyOnceWith(
      'question',
      [['first', 'second', 'custom'], ['detail answer']]
    );
  });
});
