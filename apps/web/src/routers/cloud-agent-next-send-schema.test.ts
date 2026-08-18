import { describe, expect, it } from '@jest/globals';
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

const commandPayload = () => ({
  type: 'command' as const,
  command: 'ls',
});

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
});

describe('basePrepareSessionNextSchema initialPayload', () => {
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
});
