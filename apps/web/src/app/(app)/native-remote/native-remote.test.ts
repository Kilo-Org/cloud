jest.mock('posthog-js/react', () => ({ useFeatureFlagEnabled: jest.fn() }));
jest.mock('@kilocode/cloud-agent-sdk', () => ({ NativeSyncClient: jest.fn() }));

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { NativeSyncClient, type NativeEvent } from '@kilocode/cloud-agent-sdk';
import NativeRemotePage from './page';
import {
  commandResult,
  pendingRequests,
  transcriptText,
  sendNativePrompt,
} from './native-remote-events';
function event(type: string, data: unknown, seq = 1): NativeEvent {
  return {
    v: 1,
    channel: 'events',
    type,
    seq,
    from: 'runner',
    at: 1,
    body: { version: 1, incarnation: 'runner', runID: '1', data: { type, data } },
  };
}

it.each([false, undefined])('hides all UI and never creates a client when flag is %s', enabled => {
  jest.mocked(useFeatureFlagEnabled).mockReturnValue(enabled);
  expect(renderToStaticMarkup(React.createElement(NativeRemotePage))).toBe('');
  expect(NativeSyncClient).not.toHaveBeenCalled();
  expect(useFeatureFlagEnabled).toHaveBeenCalledWith('native-remote-web');
});
it('tracks actual native permission asks and settlement', () => {
  const asked = event('permission.asked', {
    id: 'per_1',
    sessionID: 'ses_1',
    action: 'shell',
    resources: ['pwd'],
  });
  expect(pendingRequests([asked]).permissions).toEqual([
    { id: 'per_1', action: 'shell', resources: ['pwd'] },
  ]);
  expect(
    pendingRequests([asked, event('permission.replied', { requestID: 'per_1', reply: 'once' }, 2)])
      .permissions
  ).toEqual([]);
});
it('tracks native question forms and rejection', () => {
  const form = {
    id: 'frm_1',
    title: 'Choose',
    metadata: { kind: 'question' },
    fields: [{ type: 'string', key: 'q0', options: [{ value: 'Yes' }] }],
  };
  const asked = event('form.created', { form });
  expect(pendingRequests([asked]).questions).toHaveLength(1);
  expect(pendingRequests([asked, event('form.cancelled', { id: 'frm_1' }, 2)]).questions).toEqual(
    []
  );
});
it('replaces pending inventory on first attachment and subsequent runner state', () => {
  const inventory: NativeEvent = {
    ...event('remote.state', {}),
    body: {
      incarnation: 'runner',
      runID: '1',
      running: true,
      pending: {
        permissions: [{ requestID: 'preexisting', tool: 'shell', summary: 'Read fixture' }],
        questions: [{ requestID: 'question', fields: [{ type: 'string', key: 'q0' }] }],
      },
    },
  };
  expect(pendingRequests([inventory]).permissions).toEqual([
    { id: 'preexisting', action: 'shell', resources: ['Read fixture'] },
  ]);
  expect(pendingRequests([inventory]).questions[0]?.id).toBe('question');
  const settled = { ...inventory, seq: 2, body: { pending: { permissions: [], questions: [] } } };
  expect(pendingRequests([inventory, settled])).toEqual({ permissions: [], questions: [] });
});
it('does not mistake delivery or unknown execution for a successful result', () => {
  expect(commandResult({ status: 'succeeded', result: { sessionID: 'ses_1' } })).toEqual({
    sessionID: 'ses_1',
  });
  expect(() => commandResult({ status: 'failed', error: { message: 'No permission' } })).toThrow(
    'No permission'
  );
  expect(() => commandResult({ status: 'unknown' })).toThrow('unknown');
});
it('renders message text parts without interpreting HTML', () => {
  expect(
    transcriptText([{ type: 'text', text: '<script>hello</script>' }, { text: 'world' }])
  ).toBe('<script>hello</script>\nworld');
});

it('sends prompts with explicit offline queue choice and only safe slash commands', async () => {
  const connection = {
    sendMessage: jest.fn().mockResolvedValue('message-id'),
    sendCommand: jest.fn().mockResolvedValue('command-id'),
    clear: jest.fn(),
  };
  await expect(sendNativePrompt(connection, ' hello ', true)).resolves.toBe('message-id');
  expect(connection.sendMessage).toHaveBeenCalledWith('hello', { queueIfOffline: true });
  await expect(sendNativePrompt(connection, '/models provider/model', false)).resolves.toBe(
    'command-id'
  );
  expect(connection.sendCommand).toHaveBeenCalledWith('models', 'provider/model');
  await expect(sendNativePrompt(connection, '/shell rm -rf', true)).rejects.toThrow('Use /compact');
  expect(connection.sendCommand).toHaveBeenCalledTimes(1);
});
it('clears only the local view and sends no runner command', async () => {
  const connection = {
    sendMessage: jest.fn().mockResolvedValue('message-id'),
    sendCommand: jest.fn().mockResolvedValue('command-id'),
    clear: jest.fn(),
  };
  await expect(sendNativePrompt(connection, '/clear', false)).resolves.toBe('');
  expect(connection.clear).toHaveBeenCalledTimes(1);
  expect(connection.sendMessage).not.toHaveBeenCalled();
  expect(connection.sendCommand).not.toHaveBeenCalled();
});
