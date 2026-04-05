import type { FilePart, Message, Part, TextPart } from '@/types/opencode.gen';
import { createChatProcessor } from './chat-processor';
import type { ChatEvent } from './normalizer';
import { createMemoryStorage } from './storage/memory';

// Helpers that return properly typed stubs (literal role/type fields).
function makeUserMsg(id: string, sessionID = 'ses-1') {
  return {
    id,
    sessionID,
    role: 'user' as const,
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'a', modelID: 'b' },
  } satisfies Message;
}

function makeAssistantMsg(id: string, parentID: string, sessionID = 'ses-1') {
  return {
    id,
    sessionID,
    role: 'assistant' as const,
    time: { created: 2 },
    parentID,
    modelID: 'claude',
    providerID: 'anthropic',
    mode: 'code',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies Message;
}

function makeTextPart(id: string, messageID: string, text: string, sessionID = 'ses-1') {
  return {
    id,
    sessionID,
    messageID,
    type: 'text' as const,
    text,
  } satisfies Part;
}

function makeFilePart(id: string, messageID: string, sessionID = 'ses-1') {
  return {
    id,
    sessionID,
    messageID,
    type: 'file' as const,
    mime: 'text/plain',
    filename: 'readme.txt',
    url: 'data:text/plain;base64,aGVsbG8=',
    source: {
      type: 'file' as const,
      path: '/readme.txt',
      text: { value: 'file content here', start: 0, end: 17 },
    },
  } satisfies FilePart;
}

describe('createChatProcessor', () => {
  describe('message.updated', () => {
    it('upserts message info into storage', () => {
      const storage = createMemoryStorage();
      const processor = createChatProcessor(storage);
      const msg = makeUserMsg('msg-1');

      processor.process({ type: 'message.updated', info: msg });

      expect(storage.getMessageIds()).toEqual(['msg-1']);
      expect(storage.getMessageInfo('msg-1')).toEqual(msg);
    });
  });

  describe('message.part.updated', () => {
    it('upserts part into storage', () => {
      const storage = createMemoryStorage();
      const processor = createChatProcessor(storage);
      const part = makeTextPart('part-1', 'msg-1', 'hello');

      processor.process({ type: 'message.part.updated', part });

      const stored = storage.getParts('msg-1');
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('part-1');
      expect((stored[0] satisfies Part as TextPart).text).toBe('hello');
    });

    it('strips file content before storing', () => {
      const storage = createMemoryStorage();
      const processor = createChatProcessor(storage);
      const part = makeFilePart('part-file', 'msg-1');

      processor.process({ type: 'message.part.updated', part });

      const stored = storage.getParts('msg-1');
      expect(stored).toHaveLength(1);
      const storedFile = stored[0] satisfies Part as FilePart;
      expect(storedFile.url).toBe('');
      expect(storedFile.source?.text.value).toBe('');
    });
  });

  describe('message.part.delta', () => {
    it('applies text delta to storage', () => {
      const storage = createMemoryStorage();
      const processor = createChatProcessor(storage);

      const delta: ChatEvent = {
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'part-1',
        field: 'text',
        delta: 'hello',
      };

      processor.process(delta);

      const stored = storage.getParts('msg-1');
      expect(stored).toHaveLength(1);
      expect((stored[0] satisfies Part as TextPart).text).toBe('hello');
    });
  });

  describe('message.part.removed', () => {
    it('deletes part from storage', () => {
      const storage = createMemoryStorage();
      const processor = createChatProcessor(storage);
      const part = makeTextPart('part-1', 'msg-1', 'hello');

      processor.process({ type: 'message.part.updated', part });
      expect(storage.getParts('msg-1')).toHaveLength(1);

      processor.process({
        type: 'message.part.removed',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'part-1',
      });

      expect(storage.getParts('msg-1')).toHaveLength(0);
    });
  });

  describe('sequential processing', () => {
    it('produces correct final state from multiple events', () => {
      const storage = createMemoryStorage();
      const processor = createChatProcessor(storage);

      const user = makeUserMsg('msg-1');
      const assistant = makeAssistantMsg('msg-2', 'msg-1');

      // 1. User message arrives
      processor.process({ type: 'message.updated', info: user });

      // 2. Assistant message arrives
      processor.process({ type: 'message.updated', info: assistant });

      // 3. Text part with streaming deltas
      processor.process({
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-2',
        partId: 'part-1',
        field: 'text',
        delta: 'Hello ',
      });
      processor.process({
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-2',
        partId: 'part-1',
        field: 'text',
        delta: 'world',
      });

      // 4. Full part update replaces the delta-seeded part
      processor.process({
        type: 'message.part.updated',
        part: makeTextPart('part-1', 'msg-2', 'Hello world!'),
      });

      // 5. Second part arrives then gets removed
      processor.process({
        type: 'message.part.updated',
        part: makeTextPart('part-2', 'msg-2', 'ephemeral'),
      });
      processor.process({
        type: 'message.part.removed',
        sessionId: 'ses-1',
        messageId: 'msg-2',
        partId: 'part-2',
      });

      // Verify final state
      expect(storage.getMessageIds()).toEqual(['msg-1', 'msg-2']);
      expect(storage.getMessageInfo('msg-1')).toEqual(user);
      expect(storage.getMessageInfo('msg-2')).toEqual(assistant);

      const parts = storage.getParts('msg-2');
      expect(parts).toHaveLength(1);
      expect(parts[0].id).toBe('part-1');
      expect((parts[0] satisfies Part as TextPart).text).toBe('Hello world!');
    });
  });
});
