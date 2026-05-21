import { describe, expect, it } from 'vitest';

import {
  buildMessageEditContent,
  remainingEditableAttachments,
  type AttachmentBlock,
} from '../src';

const firstAttachment = {
  type: 'attachment',
  attachmentId: '01HV0000000000000000000001',
  mimeType: 'image/png',
  size: 123,
  filename: 'photo.png',
} satisfies AttachmentBlock;

const secondAttachment = {
  type: 'attachment',
  attachmentId: '01HV0000000000000000000002',
  mimeType: 'application/pdf',
  size: 456,
  filename: 'brief.pdf',
} satisfies AttachmentBlock;

describe('message edit content helpers', () => {
  it('keeps original attachments not marked removed', () => {
    expect(
      remainingEditableAttachments(
        [firstAttachment, secondAttachment],
        [secondAttachment.attachmentId]
      )
    ).toEqual([firstAttachment]);
  });

  it('builds edit content from trimmed text and remaining attachments', () => {
    expect(
      buildMessageEditContent({
        text: '  updated message  ',
        originalAttachments: [firstAttachment, secondAttachment],
        removedAttachmentIds: [firstAttachment.attachmentId],
      })
    ).toEqual([{ type: 'text', text: 'updated message' }, secondAttachment]);
  });

  it('accepts a Set of removed attachment ids', () => {
    expect(
      buildMessageEditContent({
        text: 'hi',
        originalAttachments: [firstAttachment, secondAttachment],
        removedAttachmentIds: new Set([firstAttachment.attachmentId]),
      })
    ).toEqual([{ type: 'text', text: 'hi' }, secondAttachment]);
  });

  it('allows attachment-only edit content', () => {
    expect(
      buildMessageEditContent({
        text: '   ',
        originalAttachments: [firstAttachment, secondAttachment],
        removedAttachmentIds: [secondAttachment.attachmentId],
      })
    ).toEqual([firstAttachment]);
  });
});
