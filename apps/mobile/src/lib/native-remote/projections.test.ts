import { type NativeEvent, type NativeSessionConnection } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createdSession, pendingRequests, sendNativePrompt, transcriptText } from './projections';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

function event(type: string, body: unknown, seq = 1): NativeEvent {
  return { v: 1, channel: 'events', seq, from: 'runner', at: 1, type, body };
}
function live(type: string, data: unknown, seq = 2) {
  return event(type, { data: { data } }, seq);
}
const fields = [{ key: 'choice', type: 'select', options: [{ value: 'yes', label: 'Yes' }] }];

function connection() {
  return {
    clear: vi.fn(),
    sendMessage: vi
      .fn<NativeSessionConnection['sendMessage']>()
      .mockResolvedValue('message-command'),
    sendCommand: vi.fn<NativeSessionConnection['sendCommand']>().mockResolvedValue('slash-command'),
  };
}

describe('native pending requests', () => {
  it('opens pending inventory for an already waiting runner', () => {
    const pending = pendingRequests([
      event('remote.state', {
        pending: {
          permissions: [{ requestID: 'p1', tool: 'shell', summary: 'Run command' }],
          questions: [{ requestID: 'q1', fields }],
        },
      }),
    ]);
    expect(pending.permissions).toEqual([
      { id: 'p1', action: 'shell', resources: ['Run command'] },
    ]);
    expect(pending.questions).toEqual([{ id: 'q1', metadata: { kind: 'question' }, fields }]);
  });

  it('applies live additions and removals after the inventory', () => {
    const pending = pendingRequests([
      event('remote.state', { pending: { permissions: [], questions: [] } }),
      live('permission.asked', { id: 'p1', action: 'edit', resources: ['file'] }),
      live('permission.asked', { id: 'p2', action: 'shell', resources: ['test'] }, 3),
      live('permission.replied', { requestID: 'p1' }, 4),
      live(
        'form.created',
        { form: { id: 'q1', title: 'Choose', metadata: { kind: 'question' }, fields } },
        5
      ),
      live(
        'form.created',
        { form: { id: 'q2', title: 'Choose', metadata: { kind: 'question' }, fields } },
        6
      ),
      live('form.replied', { id: 'q1' }, 7),
      live('form.cancelled', { id: 'q2' }, 8),
    ]);
    expect(pending.permissions.map(request => request.id)).toEqual(['p2']);
    expect(pending.questions).toEqual([]);
  });

  it('replaces older requests with the newest authoritative inventory', () => {
    const pending = pendingRequests([
      live('permission.asked', { id: 'old', action: 'shell', resources: [] }),
      event(
        'remote.state',
        { pending: { permissions: [], questions: [{ requestID: 'new', fields }] } },
        4
      ),
      live('permission.asked', { id: 'after', action: 'edit', resources: [] }, 5),
    ]);
    expect(pending.permissions.map(request => request.id)).toEqual(['after']);
    expect(pending.questions.map(request => request.id)).toEqual(['new']);
  });

  it('does not retain stale controls after an unreadable inventory or malformed live event', () => {
    const pending = pendingRequests([
      live('permission.asked', { id: 'old', action: 'shell', resources: [] }),
      event('remote.state', { pending: null }, 4),
      live('form.created', { form: { id: 'invalid' } }, 5),
      event('permission.asked', null, 6),
    ]);
    expect(pending).toEqual({ permissions: [], questions: [] });
  });
});

describe('native prompt dispatch', () => {
  it('keeps /clear local and never submits a command or prompt', async () => {
    const remote = connection();
    expect(await sendNativePrompt(remote, ' /clear ', true)).toBe('');
    expect(remote.clear).toHaveBeenCalledOnce();
    expect(remote.sendMessage).not.toHaveBeenCalled();
    expect(remote.sendCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'passes queueIfOffline=%s only to a normal prompt',
    async queueIfOffline => {
      const remote = connection();
      expect(await sendNativePrompt(remote, ' hello ', queueIfOffline)).toBe('message-command');
      expect(remote.sendMessage).toHaveBeenCalledExactlyOnceWith('hello', { queueIfOffline });
    }
  );

  it.each(['compact', 'new', 'skill', 'models', 'agents'])(
    'dispatches safe /%s through the SDK',
    async command => {
      const remote = connection();
      await sendNativePrompt(remote, `/${command} example argument`, true);
      expect(remote.sendCommand).toHaveBeenCalledExactlyOnceWith(command, 'example argument');
      expect(remote.sendMessage).not.toHaveBeenCalled();
    }
  );

  it('rejects unknown commands without turning them into a prompt', async () => {
    const remote = connection();
    await expect(sendNativePrompt(remote, '/shell rm', true)).rejects.toThrow(
      'nativeRemote.unsafeCommand'
    );
    expect(remote.sendMessage).not.toHaveBeenCalled();
    expect(remote.sendCommand).not.toHaveBeenCalled();
  });
});

describe('native runner replies and transcript', () => {
  it('reads the successful create session outcome', () => {
    expect(createdSession({ status: 'succeeded', result: { sessionID: 'ses-created' } })).toBe(
      'ses-created'
    );
  });
  it('distinguishes ambiguous creation from a failed or invalid reply', () => {
    expect(() => createdSession({ status: 'unknown' })).toThrow('nativeRemote.creationUnknown');
    expect(() => createdSession({ status: 'failed', error: { message: 'Host refused' } })).toThrow(
      'Host refused'
    );
    expect(() => createdSession({ status: 'succeeded', result: {} })).toThrow(
      'nativeRemote.invalidReply'
    );
    expect(() => createdSession(null)).toThrow('nativeRemote.invalidReply');
  });
  it('renders snapshot and streamed text parts while retaining other native parts', () => {
    expect(transcriptText([{ type: 'text', text: 'Hello' }, { text: 'world' }])).toBe(
      'Hello\nworld'
    );
    expect(transcriptText({ type: 'tool', state: 'running' })).toContain('running');
    expect(transcriptText('delta')).toBe('delta');
  });
});
