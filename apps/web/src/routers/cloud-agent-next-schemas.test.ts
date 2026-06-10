import { describe, expect, it } from '@jest/globals';
import {
  basePrepareSessionNextSchema,
  baseSendMessageNextSchema,
  cloudAgentAttachmentsSchema,
  cloudAgentGetAttachmentUploadUrlSchema,
} from './cloud-agent-next-schemas';

const MESSAGE_UUID = '12345678-1234-4234-9234-123456789abc';
const PDF_FILENAME = '87654321-4321-4321-8321-cba987654321.pdf';
const TXT_FILENAME = '87654321-4321-4321-8321-cba987654321.txt';
const MD_FILENAME = '87654321-4321-4321-8321-cba987654321.md';
const CSV_FILENAME = '87654321-4321-4321-8321-cba987654321.csv';

describe('cloudAgentAttachmentsSchema', () => {
  it('accepts document attachments and up to five ordered files', () => {
    expect(
      cloudAgentAttachmentsSchema.parse({
        path: MESSAGE_UUID,
        files: [PDF_FILENAME, TXT_FILENAME, MD_FILENAME, CSV_FILENAME],
      })
    ).toEqual({
      path: MESSAGE_UUID,
      files: [PDF_FILENAME, TXT_FILENAME, MD_FILENAME, CSV_FILENAME],
    });
  });

  it('rejects unsupported suffixes and more than five attachments', () => {
    expect(
      cloudAgentAttachmentsSchema.safeParse({ path: MESSAGE_UUID, files: ['file.docx'] }).success
    ).toBe(false);
    expect(
      cloudAgentAttachmentsSchema.safeParse({
        path: MESSAGE_UUID,
        files: Array.from({ length: 6 }, () => PDF_FILENAME),
      }).success
    ).toBe(false);
  });
});

describe('cloudAgentGetAttachmentUploadUrlSchema', () => {
  it.each(['image/png', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv'] as const)(
    'accepts %s document upload requests',
    contentType => {
      expect(
        cloudAgentGetAttachmentUploadUrlSchema.parse({
          messageUuid: MESSAGE_UUID,
          attachmentId: MESSAGE_UUID,
          contentType,
          contentLength: 5 * 1024 * 1024,
        }).contentType
      ).toBe(contentType);
    }
  );

  it('rejects unsupported MIME and oversized uploads', () => {
    expect(
      cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: MESSAGE_UUID,
        contentType: 'application/msword',
        contentLength: 1,
      }).success
    ).toBe(false);
    expect(
      cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: MESSAGE_UUID,
        contentType: 'application/pdf',
        contentLength: 5 * 1024 * 1024 + 1,
      }).success
    ).toBe(false);
  });
});

describe('basePrepareSessionNextSchema', () => {
  it('preserves structured initial slash command payloads', () => {
    const initialPayload = {
      type: 'command' as const,
      command: 'review',
      arguments: 'main',
    };

    const result = basePrepareSessionNextSchema.parse({
      githubRepo: 'kilocode/cloud',
      prompt: '/review main',
      mode: 'code',
      model: 'anthropic/claude-sonnet',
      initialPayload,
    });

    expect(result.initialPayload).toEqual(initialPayload);
  });

  it('accepts canonical attachment references and rejects ambiguous legacy input', () => {
    const prompt = {
      githubRepo: 'kilocode/cloud',
      prompt: 'Review this file',
      mode: 'code',
      model: 'anthropic/claude-sonnet',
      attachments: { path: MESSAGE_UUID, files: [MD_FILENAME] },
    };

    expect(basePrepareSessionNextSchema.parse(prompt).attachments).toEqual(prompt.attachments);
    expect(
      basePrepareSessionNextSchema.safeParse({
        ...prompt,
        images: { path: MESSAGE_UUID, files: ['87654321-4321-4321-8321-cba987654321.png'] },
      }).success
    ).toBe(false);
  });
});

describe('baseSendMessageNextSchema', () => {
  it('accepts canonical attachment references and rejects both attachment fields', () => {
    const send = {
      cloudAgentSessionId: 'agent_1',
      payload: { type: 'prompt' as const, prompt: 'Summarize', mode: 'code', model: 'test' },
      attachments: { path: MESSAGE_UUID, files: [PDF_FILENAME] },
    };

    expect(baseSendMessageNextSchema.parse(send).attachments).toEqual(send.attachments);
    expect(
      baseSendMessageNextSchema.safeParse({
        ...send,
        images: { path: MESSAGE_UUID, files: ['87654321-4321-4321-8321-cba987654321.png'] },
      }).success
    ).toBe(false);
  });
});
