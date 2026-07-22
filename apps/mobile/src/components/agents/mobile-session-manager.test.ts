import { describe, expect, it, vi } from 'vitest';

import { type AgentAttachmentSubmissionPayload } from '@/lib/agent-attachments/agent-attachment-types';
import { trpcClient } from '@/lib/trpc';
import { buildRemoteAttachmentParts } from '@/components/agents/mobile-session-manager-helpers';

vi.mock('@/lib/trpc', () => {
  const mutate = vi.fn();
  return {
    trpcClient: {
      cloudAgentNext: {
        getAttachmentDownloadUrl: { mutate },
      },
    },
  };
});

describe('buildRemoteAttachmentParts', () => {
  it('mints a presigned URL per file using remoteName and derives MIME from extension', async () => {
    const mutate = vi.mocked(trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate);
    mutate.mockResolvedValue({
      signedUrl: 'https://r2.example.com/signed',
      key: 'user-id/cloud-agent/msg-uuid/file',
      expiresAt: new Date().toISOString(),
    });

    const submission: AgentAttachmentSubmissionPayload = {
      messageUuid: 'msg-uuid',
      wire: {
        path: 'msg-uuid',
        files: ['msg-uuid.zip', 'msg-uuid.txt', 'msg-uuid.png'],
      },
      files: [
        { remoteName: 'msg-uuid.zip', originalName: 'archive.zip', size: 100 },
        { remoteName: 'msg-uuid.txt', originalName: 'notes.txt', size: 50 },
        { remoteName: 'msg-uuid.png', originalName: 'image.png', size: 200 },
      ],
    };

    const parts = await buildRemoteAttachmentParts(submission);

    expect(mutate).toHaveBeenCalledTimes(3);
    expect(mutate).toHaveBeenCalledWith({ messageUuid: 'msg-uuid', filename: 'msg-uuid.zip' });
    expect(mutate).toHaveBeenCalledWith({ messageUuid: 'msg-uuid', filename: 'msg-uuid.txt' });
    expect(mutate).toHaveBeenCalledWith({ messageUuid: 'msg-uuid', filename: 'msg-uuid.png' });

    expect(parts).toEqual([
      {
        type: 'file',
        mime: 'application/octet-stream',
        filename: 'msg-uuid.zip',
        url: 'https://r2.example.com/signed',
      },
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'msg-uuid.txt',
        url: 'https://r2.example.com/signed',
      },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'msg-uuid.png',
        url: 'https://r2.example.com/signed',
      },
    ]);
  });
});
