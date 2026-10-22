import { describe, expect, it } from '@jest/globals';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import {
  basePrepareSessionNextSchema,
  baseSendMessageNextSchema,
} from './cloud-agent-next-schemas';

const MESSAGE_UUID = '12345678-1234-4234-9234-123456789abc';
const ATTACHMENT_ID = '87654321-4321-4321-8321-cba987654321';

const promptPayload = (prompt: string) => ({
  type: 'prompt' as const,
  prompt,
  mode: 'code',
  model: 'gpt-4',
});

const commandPayload = (commandArguments?: string) => ({
  type: 'command' as const,
  command: 'ls',
  ...(commandArguments === undefined ? {} : { arguments: commandArguments }),
});

const atCap = 'x'.repeat(CLOUD_AGENT_PROMPT_MAX_LENGTH);
const overCap = 'x'.repeat(CLOUD_AGENT_PROMPT_MAX_LENGTH + 1);

const attachments = (filename: string) => ({
  path: MESSAGE_UUID,
  files: [filename],
});

const images = (filename: string) => ({
  path: MESSAGE_UUID,
  files: [filename],
});

describe('baseSendMessageNextSchema', () => {
  it('accepts an empty prompt with an attachment', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload(''),
      attachments: attachments(`${ATTACHMENT_ID}.png`),
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty prompt with an image', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload(''),
      images: images(`${ATTACHMENT_ID}.png`),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty prompt with no files', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload(''),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only prompt with no files', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload('   '),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a command payload with no prompt and no files', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: commandPayload(),
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a text-only prompt', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload('hello'),
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a text prompt with an attachment', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload('hello'),
      attachments: attachments(`${ATTACHMENT_ID}.png`),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a follow-up prompt one character over the shared cap', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: promptPayload(overCap),
    });
    expect(result.success).toBe(false);
  });

  it('accepts follow-up command arguments at the shared cap', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: commandPayload(atCap),
    });
    expect(result.success).toBe(true);
  });

  it('rejects follow-up command arguments one character over the shared cap', () => {
    const result = baseSendMessageNextSchema.safeParse({
      cloudAgentSessionId: 'cloud-session-1',
      payload: commandPayload(overCap),
    });
    expect(result.success).toBe(false);
  });
});

describe('basePrepareSessionNextSchema initialPayload', () => {
  const prepareInput = (initialPayload: unknown) => ({
    githubRepo: 'owner/repo',
    prompt: 'hello',
    mode: 'code',
    model: 'gpt-4',
    initialPayload,
  });

  it('still rejects an empty prompt in initialPayload', () => {
    const result = basePrepareSessionNextSchema.safeParse({
      githubRepo: 'owner/repo',
      prompt: 'hello',
      mode: 'code',
      model: 'gpt-4',
      initialPayload: promptPayload(''),
    });
    expect(result.success).toBe(false);
  });

  it('accepts an initialPayload prompt at the shared cap', () => {
    const result = basePrepareSessionNextSchema.safeParse(prepareInput(promptPayload(atCap)));
    expect(result.success).toBe(true);
  });

  it('rejects an initialPayload prompt one character over the shared cap', () => {
    const result = basePrepareSessionNextSchema.safeParse(prepareInput(promptPayload(overCap)));
    expect(result.success).toBe(false);
  });

  it('accepts initialPayload command arguments at the shared cap', () => {
    const result = basePrepareSessionNextSchema.safeParse(prepareInput(commandPayload(atCap)));
    expect(result.success).toBe(true);
  });

  it('rejects initialPayload command arguments one character over the shared cap', () => {
    const result = basePrepareSessionNextSchema.safeParse(prepareInput(commandPayload(overCap)));
    expect(result.success).toBe(false);
  });
});
