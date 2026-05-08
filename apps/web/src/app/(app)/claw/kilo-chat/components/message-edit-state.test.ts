import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

import { submitMessageEdit } from './message-edit-state';

describe('message edit state', () => {
  it('blocks over-limit inline edits without closing the editor', async () => {
    const calls: string[] = [];
    let closed = false;

    const submitted = await submitMessageEdit({
      messageId: 'message-1',
      editText: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1),
      originalText: 'hello',
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
