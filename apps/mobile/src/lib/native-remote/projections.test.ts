import { type NativeSessionConnection } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createdSession, sendNativePrompt, transcriptText } from './projections';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

function connection() {
  return {
    clear: vi.fn(),
    sendMessage: vi
      .fn<NativeSessionConnection['sendMessage']>()
      .mockResolvedValue('message-command'),
    sendCommand: vi.fn<NativeSessionConnection['sendCommand']>().mockResolvedValue('slash-command'),
  };
}

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
