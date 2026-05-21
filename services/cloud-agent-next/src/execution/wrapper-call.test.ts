import { describe, expect, it, vi } from 'vitest';
import { dispatchToWrapper, type WrapperCallContext } from './wrapper-call.js';
import type { WrapperClient, ExecutionBinding } from '../kilo/wrapper-client.js';

function makeCtx(overrides: Partial<WrapperCallContext> = {}): WrapperCallContext {
  const execution: ExecutionBinding = {
    executionId: 'exc_test',
    ingestUrl: 'https://example.com/ingest',
    ingestToken: 'tok',
    workerAuthToken: 'jwt',
  };
  return {
    execution,
    normalizedMode: 'code',
    model: { providerID: 'kilo', modelID: 'sonnet' },
    variant: undefined,
    autoCommit: false,
    condenseOnComplete: false,
    messageId: undefined,
    fileParts: [],
    ...overrides,
  };
}

function makeMocks() {
  const promptMock = vi.fn().mockResolvedValue({ messageId: 'msg_42' });
  const commandMock = vi.fn().mockResolvedValue(undefined);
  const client = {
    prompt: promptMock,
    command: commandMock,
  } as unknown as WrapperClient;
  return { client, promptMock, commandMock };
}

describe('dispatchToWrapper', () => {
  it('routes prompt payload to client.prompt with built options', async () => {
    const { client, promptMock, commandMock } = makeMocks();
    await dispatchToWrapper(client, makeCtx({ messageId: 'msg_1' }), {
      type: 'prompt',
      prompt: 'do the thing',
    });

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(commandMock).not.toHaveBeenCalled();
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'do the thing',
        agent: 'code',
        messageId: 'msg_1',
      })
    );
    const opts = promptMock.mock.calls[0]?.[0] as { execution: { executionId: string } };
    expect(opts.execution.executionId).toBe('exc_test');
  });

  it('passes tool overrides to prompt payloads', async () => {
    const { client, promptMock } = makeMocks();
    await dispatchToWrapper(client, makeCtx({ tools: { question: false, plan_enter: false } }), {
      type: 'prompt',
      prompt: 'do the thing',
    });

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: { question: false, plan_enter: false },
      })
    );
  });

  it('uses parts when image attachments are present', async () => {
    const { client, promptMock } = makeMocks();
    const fileParts = [
      { type: 'file' as const, mime: 'image/png', url: 'file:///tmp/x.png', filename: 'x.png' },
    ];
    await dispatchToWrapper(client, makeCtx({ fileParts }), {
      type: 'prompt',
      prompt: 'caption this',
    });

    const call = promptMock.mock.calls[0]?.[0] as {
      prompt?: string;
      parts?: Array<{ type: string }>;
    };
    expect(call.prompt).toBeUndefined();
    expect(call.parts).toEqual([{ type: 'text', text: 'caption this' }, ...fileParts]);
  });

  it('routes command payload to client.command, carrying post-processing options', async () => {
    const { client, promptMock, commandMock } = makeMocks();
    await dispatchToWrapper(
      client,
      makeCtx({ messageId: 'msg_should_be_ignored', autoCommit: true, condenseOnComplete: true }),
      {
        type: 'command',
        command: 'review',
        arguments: 'main branch',
      }
    );

    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(promptMock).not.toHaveBeenCalled();
    const args = commandMock.mock.calls[0]?.[0] as {
      command: string;
      args: string;
      autoCommit: boolean;
      condenseOnComplete: boolean;
      execution: { executionId: string };
    };
    expect(args.command).toBe('review');
    expect(args.args).toBe('main branch');
    expect(args.autoCommit).toBe(true);
    expect(args.condenseOnComplete).toBe(true);
    expect(args.execution.executionId).toBe('exc_test');
  });

  it('handles command with empty args', async () => {
    const { client, commandMock } = makeMocks();
    await dispatchToWrapper(client, makeCtx(), {
      type: 'command',
      command: 'init',
      arguments: '',
    });

    const args = commandMock.mock.calls[0]?.[0] as { command: string; args: string };
    expect(args.command).toBe('init');
    expect(args.args).toBe('');
  });
});
