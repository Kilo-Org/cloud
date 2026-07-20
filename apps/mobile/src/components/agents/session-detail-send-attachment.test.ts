import { type RemoteAttachmentPart } from 'cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { buildRemoteAttachmentPartsWithRetryableFeedback } from './session-detail-send-attachment';
import { type AgentAttachmentSubmissionPayload } from '@/lib/agent-attachments/agent-attachment-types';

const submission: AgentAttachmentSubmissionPayload = {
  wire: { path: 'msg-uuid', files: ['server-name.txt'] },
  messageUuid: 'msg-uuid',
  files: [
    {
      remoteName: 'server-name.txt',
      originalName: 'original-name.txt',
      size: 1024,
    },
  ],
};

describe('buildRemoteAttachmentPartsWithRetryableFeedback', () => {
  it('returns parts when the underlying builder succeeds', async () => {
    const parts: RemoteAttachmentPart[] = [
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'server-name.txt',
        url: 'https://r2.example.com/signed.txt',
      },
    ];
    const result = await buildRemoteAttachmentPartsWithRetryableFeedback(submission, async () => {
      await Promise.resolve();
      return parts;
    });
    expect(result).toEqual({ ok: true, parts });
  });

  it('returns a retryable message when the underlying builder rejects', async () => {
    const result = await buildRemoteAttachmentPartsWithRetryableFeedback(submission, async () => {
      await Promise.resolve();
      throw new Error('presign network failure');
    });
    expect(result).toEqual({
      ok: false,
      message: "Couldn't attach files. Tap send to try again.",
    });
  });
});
