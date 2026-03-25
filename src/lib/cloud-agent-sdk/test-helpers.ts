import { normalize, isChatEvent } from './normalizer';
import { createMemoryStorage } from './storage/memory';
import { createChatProcessor } from './chat-processor';
import { createServiceState } from './service-state';
import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';
import type { UserMessage, TextPart } from '@/types/opencode.gen';
import type {
  KiloSessionId,
  CloudAgentSessionId,
  SessionInfo,
  SessionSnapshot,
  MessageInfo,
} from './types';

/** Cast a plain string to KiloSessionId in tests. */
function kiloId(id: string): KiloSessionId {
  return id as KiloSessionId;
}

/** Cast a plain string to CloudAgentSessionId in tests. */
function cloudAgentId(id: string): CloudAgentSessionId {
  return id as CloudAgentSessionId;
}

function createTestSession() {
  const storage = createMemoryStorage();
  const chatProcessor = createChatProcessor(storage);
  const serviceState = createServiceState({ rootSessionId: 'ses-1' });

  function feedEvent(raw: CloudAgentEvent): void {
    const event = normalize(raw);
    if (!event) return;

    if (isChatEvent(event)) {
      chatProcessor.process(event);
    } else {
      serviceState.process(event);
    }
  }

  return { storage, serviceState, feedEvent };
}

// ---------------------------------------------------------------------------
// Typed stub factories for SessionSnapshot tests
// ---------------------------------------------------------------------------

function stubSessionInfo(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return { id: overrides.id, parentID: overrides.parentID };
}

function stubUserMessage(
  overrides: Partial<UserMessage> & { id: string; sessionID: string }
): UserMessage {
  return {
    role: 'user',
    time: { created: 0 },
    agent: 'test',
    model: { providerID: 'test', modelID: 'test' },
    ...overrides,
  };
}

function stubTextPart(
  overrides: Partial<TextPart> & { id: string; sessionID: string; messageID: string }
): TextPart {
  return {
    type: 'text',
    text: '',
    ...overrides,
  };
}

function makeSnapshot(
  info: Partial<SessionInfo> & { id: string },
  messages: Array<{ info: MessageInfo; parts: TextPart[] }> = []
): SessionSnapshot {
  return { info: stubSessionInfo(info), messages };
}

export {
  createTestSession,
  kiloId,
  cloudAgentId,
  stubSessionInfo,
  stubUserMessage,
  stubTextPart,
  makeSnapshot,
};
