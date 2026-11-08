import {
  commandResult,
  commandRunner,
  transcriptText,
  sendNativePrompt,
  type CommandOutcome,
} from './native-remote-events';
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
it('runs one command per control and leaves other controls free', async () => {
  const outcomes: CommandOutcome[] = [];
  const run = commandRunner(outcome => outcomes.push(outcome));
  let finish: (value: string) => void = () => {};
  const pending = run(
    'prompt',
    () =>
      new Promise<string>(resolve => {
        finish = resolve;
      })
  );
  await expect(run('prompt', () => Promise.resolve('second'))).resolves.toBe(false);
  expect(outcomes).toEqual([{ error: '' }]);
  await expect(run('abort', () => Promise.resolve('abort-id'))).resolves.toBe(true);
  finish('first');
  await expect(pending).resolves.toBe(true);
  expect(outcomes).toEqual([
    { error: '' },
    { error: '' },
    { commandID: 'abort-id' },
    { commandID: 'first' },
  ]);
  await expect(run('prompt', () => Promise.reject(new Error('No permission')))).resolves.toBe(
    false
  );
  expect(outcomes.at(-1)).toEqual({ error: 'No permission' });
  await expect(run('prompt', () => Promise.resolve('after'))).resolves.toBe(true);
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
