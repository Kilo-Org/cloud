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
} from '../src/schemas';

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
  const validConvId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

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
    it('rejects whitespace-only text block', () => {
      const res = createMessageRequestSchema.safeParse({
        conversationId: validConvId,
        content: [{ type: 'text', text: '   ' }],
      });
      expect(res.success).toBe(false);
    });

    it('trims text on create', () => {
      const res = createMessageRequestSchema.safeParse({
        conversationId: validConvId,
        content: [{ type: 'text', text: '  hi  ' }],
      });
      expect(res.success).toBe(true);
      if (res.success) {
        const block = res.data.content[0];
        expect(block.type).toBe('text');
        if (block.type === 'text') expect(block.text).toBe('hi');
      }
    });
  });

  describe('editMessageRequestSchema', () => {
    it('rejects whitespace-only text block on edit', () => {
      const res = editMessageRequestSchema.safeParse({
        conversationId: validConvId,
        content: [{ type: 'text', text: '   ' }],
        timestamp: Date.now(),
      });
      expect(res.success).toBe(false);
    });

    it('trims text on edit', () => {
      const res = editMessageRequestSchema.safeParse({
        conversationId: validConvId,
        content: [{ type: 'text', text: '  edited  ' }],
        timestamp: Date.now(),
      });
      expect(res.success).toBe(true);
      if (res.success) {
        const block = res.data.content[0];
        if (block.type === 'text') expect(block.text).toBe('edited');
      }
    });
  });
});
