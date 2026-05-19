import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

import { buildEditContent, submitMessageEdit } from './message-edit-state';

describe('message edit state', () => {
  it('blocks over-limit inline edits without closing the editor', async () => {
    const calls: string[] = [];
    let closed = false;

    const submitted = await submitMessageEdit({
      messageId: 'message-1',
      editText: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1),
      originalText: 'hello',
      originalAttachments: [],
      removedAttachmentIds: new Set(),
      onEdit: async (_messageId, content) => {
        calls.push(content[0]?.type ?? 'missing');
        return true;
      },
      closeEditor: () => {
        closed = true;
      },
    });

    expect(submitted).toBe(false);
    expect(calls).toEqual([]);
    expect(closed).toBe(false);
  });

  it('keeps the editor open when the edit mutation fails', async () => {
    let closed = false;
    const draft = 'updated draft';

    const submitted = await submitMessageEdit({
      messageId: 'message-1',
      editText: draft,
      originalText: 'hello',
      originalAttachments: [],
      removedAttachmentIds: new Set(),
      onEdit: async () => false,
      closeEditor: () => {
        closed = true;
      },
    });

    expect(submitted).toBe(false);
    expect(closed).toBe(false);
    expect(draft).toBe('updated draft');
  });
});

describe('buildEditContent', () => {
  const att = (id: string, name: string) => ({
    type: 'attachment' as const,
    attachmentId: id,
    mimeType: 'image/png',
    size: 10,
    filename: name,
  });

  it('returns just text when there are no attachments', () => {
    expect(
      buildEditContent({ text: 'hi', originalAttachments: [], removedIds: new Set() })
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('keeps attachments not in removedIds', () => {
    expect(
      buildEditContent({
        text: 'hi',
        originalAttachments: [att('a', 'a.png'), att('b', 'b.png')],
        removedIds: new Set(['a']),
      })
    ).toEqual([{ type: 'text', text: 'hi' }, att('b', 'b.png')]);
  });

  it('omits the text block when text is empty but attachments remain', () => {
    expect(
      buildEditContent({
        text: '   ',
        originalAttachments: [att('a', 'a.png')],
        removedIds: new Set(),
      })
    ).toEqual([att('a', 'a.png')]);
  });
});
