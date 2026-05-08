import { describe, it, expect } from 'vitest';
import {
  renameConversationRequestSchema,
  createConversationRequestSchema,
  createBotConversationRequestSchema,
  textBlockSchema,
  createMessageRequestSchema,
  editMessageRequestSchema,
  CONVERSATION_TITLE_MAX_CHARS,
  MESSAGE_TEXT_MAX_CHARS,
  typingRequestSchema,
  botStatusRecordSchema,
  botStatusRequestSchema,
  conversationStatusRecordSchema,
  conversationStatusRequestSchema,
} from '../src/schemas';

const validConversationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const validClientId = '01HXYZ00000ABCDEFGHJKMNPQV';
const uuidClientId = '8bb5a00b-98a3-4910-bda3-2669bcde23bc';

describe('title schemas — trim and reject empty', () => {
  describe('renameConversationRequestSchema', () => {
    it('rejects empty string', () => {
      const res = renameConversationRequestSchema.safeParse({ title: '' });
      expect(res.success).toBe(false);
    });

    it('rejects whitespace-only string', () => {
      const res = renameConversationRequestSchema.safeParse({ title: '   ' });
      expect(res.success).toBe(false);
    });

    it('rejects tabs and newlines only', () => {
      const res = renameConversationRequestSchema.safeParse({ title: '\t\n\r ' });
      expect(res.success).toBe(false);
    });

    it('trims leading and trailing whitespace', () => {
      const res = renameConversationRequestSchema.safeParse({ title: '  hello world  ' });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.title).toBe('hello world');
    });

    it('accepts non-empty title', () => {
      const res = renameConversationRequestSchema.safeParse({ title: 'My Chat' });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.title).toBe('My Chat');
    });

    it('rejects title longer than the cap', () => {
      const res = renameConversationRequestSchema.safeParse({
        title: 'a'.repeat(CONVERSATION_TITLE_MAX_CHARS + 1),
      });
      expect(res.success).toBe(false);
    });

    it('does not filter control characters (out of scope)', () => {
      const res = renameConversationRequestSchema.safeParse({ title: 'a\u0000b\u0001c' });
      expect(res.success).toBe(true);
    });
  });

  describe('createConversationRequestSchema', () => {
    it('rejects whitespace-only title', () => {
      const res = createConversationRequestSchema.safeParse({
        sandboxId: 'sandbox-abc',
        title: '   ',
      });
      expect(res.success).toBe(false);
    });

    it('trims title when provided', () => {
      const res = createConversationRequestSchema.safeParse({
        sandboxId: 'sandbox-abc',
        title: '  trimmed  ',
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.title).toBe('trimmed');
    });

    it('accepts missing title (optional)', () => {
      const res = createConversationRequestSchema.safeParse({ sandboxId: 'sandbox-abc' });
      expect(res.success).toBe(true);
    });
  });

  describe('createBotConversationRequestSchema', () => {
    it('rejects whitespace-only title', () => {
      const res = createBotConversationRequestSchema.safeParse({ title: '   ' });
      expect(res.success).toBe(false);
    });

    it('trims title when provided', () => {
      const res = createBotConversationRequestSchema.safeParse({ title: '  hi  ' });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.title).toBe('hi');
    });

    it('accepts missing title (optional)', () => {
      const res = createBotConversationRequestSchema.safeParse({});
      expect(res.success).toBe(true);
    });
  });
});

describe('text content blocks — trim and reject empty', () => {
  describe('textBlockSchema', () => {
    it('rejects empty text', () => {
      const res = textBlockSchema.safeParse({ type: 'text', text: '' });
      expect(res.success).toBe(false);
    });

    it('rejects whitespace-only text', () => {
      const res = textBlockSchema.safeParse({ type: 'text', text: '   ' });
      expect(res.success).toBe(false);
    });

    it('rejects tabs and newlines only', () => {
      const res = textBlockSchema.safeParse({ type: 'text', text: '\t\n\r ' });
      expect(res.success).toBe(false);
    });

    it('trims surrounding whitespace', () => {
      const res = textBlockSchema.safeParse({ type: 'text', text: '  hello  ' });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.text).toBe('hello');
    });

    it('preserves inner whitespace and newlines', () => {
      const res = textBlockSchema.safeParse({ type: 'text', text: 'line1\n  line2\n\nline3' });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.text).toBe('line1\n  line2\n\nline3');
    });

    it('rejects text longer than the cap', () => {
      const res = textBlockSchema.safeParse({
        type: 'text',
        text: 'a'.repeat(MESSAGE_TEXT_MAX_CHARS + 1),
      });
      expect(res.success).toBe(false);
    });

    it('does not filter control characters (out of scope)', () => {
      const res = textBlockSchema.safeParse({
        type: 'text',
        text: 'hi\u0000\u0001\u0002there',
      });
      expect(res.success).toBe(true);
    });
  });

  describe('createMessageRequestSchema', () => {
    it('accepts ULID client ids and rejects UUID client ids', () => {
      const content = [{ type: 'text', text: 'hello' }];
      expect(
        createMessageRequestSchema.safeParse({
          conversationId: validConversationId,
          content,
          clientId: validClientId,
        }).success
      ).toBe(true);
      expect(
        createMessageRequestSchema.safeParse({
          conversationId: validConversationId,
          content,
          clientId: uuidClientId,
        }).success
      ).toBe(false);
    });

    it('rejects whitespace-only text block', () => {
      const res = createMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [{ type: 'text', text: '   ' }],
      });
      expect(res.success).toBe(false);
    });

    it('trims text on create', () => {
      const res = createMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [{ type: 'text', text: '  hi  ' }],
      });
      expect(res.success).toBe(true);
      if (res.success) {
        const block = res.data.content[0];
        expect(block.type).toBe('text');
        if (block.type === 'text') expect(block.text).toBe('hi');
      }
    });

    it('rejects caller-supplied action resolution metadata', () => {
      const res = createMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [
          {
            type: 'actions',
            groupId: 'approval',
            actions: [{ label: 'Allow', style: 'primary', value: 'allow-once' }],
            resolved: {
              value: 'allow-once',
              resolvedBy: 'user-alice',
              resolvedAt: Date.now(),
            },
          },
        ],
      });
      expect(res.success).toBe(false);
    });

    it('rejects empty action input blocks', () => {
      const res = createMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [{ type: 'actions', groupId: 'approval', actions: [] }],
      });
      expect(res.success).toBe(false);
    });
  });

  describe('editMessageRequestSchema', () => {
    it('rejects whitespace-only text block on edit', () => {
      const res = editMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [{ type: 'text', text: '   ' }],
        timestamp: Date.now(),
      });
      expect(res.success).toBe(false);
    });

    it('trims text on edit', () => {
      const res = editMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [{ type: 'text', text: '  edited  ' }],
        timestamp: Date.now(),
      });
      expect(res.success).toBe(true);
      if (res.success) {
        const block = res.data.content[0];
        if (block.type === 'text') expect(block.text).toBe('edited');
      }
    });

    it('rejects caller-supplied action resolution metadata', () => {
      const res = editMessageRequestSchema.safeParse({
        conversationId: validConversationId,
        content: [
          {
            type: 'actions',
            groupId: 'approval',
            actions: [{ label: 'Deny', style: 'danger', value: 'deny' }],
            resolved: {
              value: 'deny',
              resolvedBy: 'user-alice',
              resolvedAt: Date.now(),
            },
          },
        ],
        timestamp: Date.now(),
      });
      expect(res.success).toBe(false);
    });
  });
});

describe('status schemas', () => {
  it('rejects negative and fractional bot status timestamps', () => {
    expect(botStatusRequestSchema.safeParse({ online: true, at: -1 }).success).toBe(false);
    expect(botStatusRequestSchema.safeParse({ online: true, at: 1.5 }).success).toBe(false);
    expect(botStatusRecordSchema.safeParse({ online: true, at: -1, updatedAt: 1000 }).success).toBe(
      false
    );
    expect(
      botStatusRecordSchema.safeParse({ online: true, at: 1000, updatedAt: 1000.5 }).success
    ).toBe(false);
  });

  it('rejects negative and fractional conversation status numbers', () => {
    expect(
      conversationStatusRequestSchema.safeParse({
        contextTokens: -1,
        contextWindow: 4096,
        model: null,
        provider: null,
        at: 1000,
      }).success
    ).toBe(false);
    expect(
      conversationStatusRequestSchema.safeParse({
        contextTokens: 0,
        contextWindow: 4096.5,
        model: null,
        provider: null,
        at: 1000,
      }).success
    ).toBe(false);
    expect(
      conversationStatusRequestSchema.safeParse({
        contextTokens: 0,
        contextWindow: 4096,
        model: null,
        provider: null,
        at: 1000.5,
      }).success
    ).toBe(false);
    expect(
      conversationStatusRecordSchema.safeParse({
        conversationId: validConversationId,
        contextTokens: 0,
        contextWindow: 4096,
        model: null,
        provider: null,
        at: 1000,
        updatedAt: -1,
      }).success
    ).toBe(false);
  });

  it('accepts zero token and window counts', () => {
    expect(
      conversationStatusRequestSchema.safeParse({
        contextTokens: 0,
        contextWindow: 0,
        model: null,
        provider: null,
        at: 0,
      }).success
    ).toBe(true);
    expect(
      conversationStatusRecordSchema.safeParse({
        conversationId: validConversationId,
        contextTokens: 0,
        contextWindow: 0,
        model: null,
        provider: null,
        at: 0,
        updatedAt: 0,
      }).success
    ).toBe(true);
  });
});

describe('plugin client request schemas', () => {
  it('requires a non-empty conversationId for typing requests', () => {
    expect(typingRequestSchema.safeParse({ conversationId: 'c1' }).success).toBe(true);
    expect(typingRequestSchema.safeParse({ conversationId: '' }).success).toBe(false);
    expect(typingRequestSchema.safeParse({}).success).toBe(false);
  });
});
