/**
 * Sample WebSocket replay covering root and child messages, streamed text,
 * task transitions, and final snapshots. Identifiers and prose are synthetic.
 */
import type { CloudAgentEvent } from '../schemas';
import type { Fixture } from './types';

const events: CloudAgentEvent[] = [
  // --- Root session: user message ---
  // eventId 1: message.updated (user msg on root session)
  {
    eventId: 1,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:40.152Z',
    data: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_00000000000000000000000001',
          sessionID: 'ses_00000000000000000000000001',
          role: 'user',
          time: { created: 1772214640111 },
          agent: 'code',
          model: { providerID: 'kilo', modelID: 'anthropic/claude-opus-4.6' },
        },
      },
      event: 'message.updated',
    },
  },
  // eventId 2: message.part.updated (user text part)
  {
    eventId: 2,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:40.152Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000001',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000001',
          type: 'text',
          text: 'Build a sample project overview with two sections.',
        },
      },
      event: 'message.part.updated',
    },
  },

  // --- Root session: busy + assistant message ---
  // eventId 5: session.status busy
  {
    eventId: 5,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:40.152Z',
    data: {
      type: 'session.status',
      properties: { sessionID: 'ses_00000000000000000000000001', status: { type: 'busy' } },
      event: 'session.status',
    },
  },
  // eventId 6: message.updated (assistant msg)
  {
    eventId: 6,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:40.432Z',
    data: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_00000000000000000000000002',
          sessionID: 'ses_00000000000000000000000001',
          role: 'assistant',
          time: { created: 1772214640377 },
          parentID: 'msg_00000000000000000000000001',
          modelID: 'anthropic/claude-opus-4.6',
          providerID: 'kilo',
          mode: 'code',
          agent: 'code',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
      event: 'message.updated',
    },
  },

  // --- Assistant streaming: step-start + text deltas ---
  // eventId 11: step-start
  {
    eventId: 11,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.076Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000002',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'step-start',
          snapshot: '0000000000000000000000000000000000000002',
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 12: empty text part (before deltas)
  {
    eventId: 12,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.076Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000003',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'text',
          text: '',
          time: { start: 1772214643064 },
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 13-21: text deltas
  {
    eventId: 13,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.076Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: '\n\nI will',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 14,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.076Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' review',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 15,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.080Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' the sample',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 16,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.122Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' notes',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 17,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.167Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' and directories',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 18,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.220Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ', then',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 19,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.277Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' prepare',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 20,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.324Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' a project',
      },
      event: 'message.part.delta',
    },
  },
  {
    eventId: 21,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.374Z',
    data: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_00000000000000000000000001',
        messageID: 'msg_00000000000000000000000002',
        partID: 'prt_00000000000000000000000003',
        field: 'text',
        delta: ' overview.',
      },
      event: 'message.part.delta',
    },
  },

  // --- First task: review sample notes ---
  // eventId 22: tool pending
  {
    eventId: 22,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:43.591Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000004',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'tool',
          callID: 'toolu_bdrk_00000000000000000000000001',
          tool: 'task',
          state: { status: 'pending', input: {}, raw: '' },
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 23: tool running
  {
    eventId: 23,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.485Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000004',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'tool',
          callID: 'toolu_bdrk_00000000000000000000000001',
          tool: 'task',
          state: {
            status: 'running',
            input: {
              description: 'Review sample notes',
              prompt: 'Read the sample notes and summarize their contents.',
              subagent_type: 'explore',
            },
            time: { start: 1772214645446 },
          },
          metadata: { openrouter: { reasoning_details: [] } },
        },
      },
      event: 'message.part.updated',
    },
  },

  // --- Child session 1: sample notes ---
  // eventId 24: session.created
  {
    eventId: 24,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.486Z',
    data: {
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_00000000000000000000000002',
          slug: 'sample-notes',
          version: '7.0.29',
          projectID: '0000000000000000000000000000000000000001',
          directory: '/workspace',
          parentID: 'ses_00000000000000000000000001',
          title: 'Review sample notes (@explore subagent)',
          permission: [
            { permission: 'todowrite', pattern: '*', action: 'deny' },
            { permission: 'todoread', pattern: '*', action: 'deny' },
            { permission: 'task', pattern: '*', action: 'deny' },
          ],
          time: { created: 1772214645451, updated: 1772214645451 },
        },
      },
      event: 'session.created',
    },
  },
  // eventId 26: tool part updated with child session metadata
  {
    eventId: 26,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.486Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000004',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'tool',
          callID: 'toolu_bdrk_00000000000000000000000001',
          tool: 'task',
          state: {
            status: 'running',
            input: {
              description: 'Review sample notes',
              prompt: 'Read the sample notes and summarize their contents.',
              subagent_type: 'explore',
            },
            title: 'Review sample notes',
            metadata: {
              sessionId: 'ses_00000000000000000000000002',
              model: { modelID: 'anthropic/claude-opus-4.6', providerID: 'kilo' },
            },
            time: { start: 1772214645457 },
          },
          metadata: { openrouter: { reasoning_details: [] } },
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 27: child 1 user message
  {
    eventId: 27,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.487Z',
    data: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_00000000000000000000000003',
          sessionID: 'ses_00000000000000000000000002',
          role: 'user',
          time: { created: 1772214645461 },
          agent: 'explore',
          model: { providerID: 'kilo', modelID: 'anthropic/claude-opus-4.6' },
          tools: { todowrite: false, todoread: false, task: false },
        },
      },
      event: 'message.updated',
    },
  },
  // eventId 28: child 1 user text part
  {
    eventId: 28,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.487Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000005',
          sessionID: 'ses_00000000000000000000000002',
          messageID: 'msg_00000000000000000000000003',
          type: 'text',
          text: 'Read the sample notes and summarize their contents.',
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 32: child 1 session busy
  {
    eventId: 32,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.488Z',
    data: {
      type: 'session.status',
      properties: { sessionID: 'ses_00000000000000000000000002', status: { type: 'busy' } },
      event: 'session.status',
    },
  },
  // eventId 33: child 1 assistant message
  {
    eventId: 33,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.488Z',
    data: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_00000000000000000000000004',
          sessionID: 'ses_00000000000000000000000002',
          role: 'assistant',
          time: { created: 1772214645470 },
          parentID: 'msg_00000000000000000000000003',
          modelID: 'anthropic/claude-opus-4.6',
          providerID: 'kilo',
          mode: 'explore',
          agent: 'explore',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
      event: 'message.updated',
    },
  },

  // --- Second task: review sample directories ---
  // eventId 34: second tool pending
  {
    eventId: 34,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:45.488Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000006',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'tool',
          callID: 'toolu_bdrk_00000000000000000000000002',
          tool: 'task',
          state: { status: 'pending', input: {}, raw: '' },
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 39: second tool running
  {
    eventId: 39,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.952Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000006',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'tool',
          callID: 'toolu_bdrk_00000000000000000000000002',
          tool: 'task',
          state: {
            status: 'running',
            input: {
              description: 'Review sample directories',
              prompt: 'List the sample directories and summarize their layout.',
              subagent_type: 'explore',
            },
            time: { start: 1772214647910 },
          },
          metadata: { openrouter: { reasoning_details: [] } },
        },
      },
      event: 'message.part.updated',
    },
  },

  // --- Child session 2: sample directories ---
  // eventId 40: session.created
  {
    eventId: 40,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.952Z',
    data: {
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_00000000000000000000000003',
          slug: 'sample-directories',
          version: '7.0.29',
          projectID: '0000000000000000000000000000000000000001',
          directory: '/workspace',
          parentID: 'ses_00000000000000000000000001',
          title: 'Review sample directories (@explore subagent)',
          permission: [
            { permission: 'todowrite', pattern: '*', action: 'deny' },
            { permission: 'todoread', pattern: '*', action: 'deny' },
            { permission: 'task', pattern: '*', action: 'deny' },
          ],
          time: { created: 1772214647914, updated: 1772214647914 },
        },
      },
      event: 'session.created',
    },
  },
  // eventId 42: second tool part updated with child session metadata
  {
    eventId: 42,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.952Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000006',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'tool',
          callID: 'toolu_bdrk_00000000000000000000000002',
          tool: 'task',
          state: {
            status: 'running',
            input: {
              description: 'Review sample directories',
              prompt: 'List the sample directories and summarize their layout.',
              subagent_type: 'explore',
            },
            title: 'Review sample directories',
            metadata: {
              sessionId: 'ses_00000000000000000000000003',
              model: { modelID: 'anthropic/claude-opus-4.6', providerID: 'kilo' },
            },
            time: { start: 1772214647917 },
          },
          metadata: { openrouter: { reasoning_details: [] } },
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 43: child 2 user message
  {
    eventId: 43,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.952Z',
    data: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_00000000000000000000000005',
          sessionID: 'ses_00000000000000000000000003',
          role: 'user',
          time: { created: 1772214647920 },
          agent: 'explore',
          model: { providerID: 'kilo', modelID: 'anthropic/claude-opus-4.6' },
          tools: { todowrite: false, todoread: false, task: false },
        },
      },
      event: 'message.updated',
    },
  },
  // eventId 44: child 2 user text part
  {
    eventId: 44,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.952Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000007',
          sessionID: 'ses_00000000000000000000000003',
          messageID: 'msg_00000000000000000000000005',
          type: 'text',
          text: 'List the sample directories and summarize their layout.',
        },
      },
      event: 'message.part.updated',
    },
  },
  // eventId 48: child 2 session busy
  {
    eventId: 48,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.952Z',
    data: {
      type: 'session.status',
      properties: { sessionID: 'ses_00000000000000000000000003', status: { type: 'busy' } },
      event: 'session.status',
    },
  },
  // eventId 49: child 2 assistant message
  {
    eventId: 49,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.953Z',
    data: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_00000000000000000000000006',
          sessionID: 'ses_00000000000000000000000003',
          role: 'assistant',
          time: { created: 1772214647929 },
          parentID: 'msg_00000000000000000000000005',
          modelID: 'anthropic/claude-opus-4.6',
          providerID: 'kilo',
          mode: 'explore',
          agent: 'explore',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
      event: 'message.updated',
    },
  },

  // --- Root assistant text snapshot (replaces deltas) ---
  // eventId 50: final text snapshot for root assistant text part
  {
    eventId: 50,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'kilocode',
    timestamp: '2026-02-27T17:50:47.953Z',
    data: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_00000000000000000000000003',
          sessionID: 'ses_00000000000000000000000001',
          messageID: 'msg_00000000000000000000000002',
          type: 'text',
          text: '\n\nI will review the sample notes and directories, then prepare a project overview.',
          time: { start: 1772214647942, end: 1772214647942 },
        },
      },
      event: 'message.part.updated',
    },
  },

  // --- Turn complete ---
  // eventId 1971: complete
  {
    eventId: 1971,
    executionId: 'exc_00000000000000000000000001',
    sessionId: 'agent_00000000-0000-4000-8000-000000000001',
    streamEventType: 'complete',
    timestamp: '2026-02-27T17:57:56.504Z',
    data: {
      exitCode: 0,
      executionId: 'exc_00000000000000000000000001',
      kiloSessionId: 'ses_00000000000000000000000001',
    },
  },
];

/**
 * Expected state after replaying all events through the normalizer.
 *
 * Parts: last message.part.updated snapshot wins for each partId.
 *   The text deltas (eventId 13-21) are superseded by the final snapshot (eventId 50).
 *   Tool parts: last snapshot for each tool partId determines final state.
 */
const sessionReplay: Fixture = {
  name: 'session-replay',
  description: 'Root and child messages with streamed text, task transitions, and final snapshots',
  events,
  expected: {
    messageIds: [
      'msg_00000000000000000000000001',
      'msg_00000000000000000000000002',
      'msg_00000000000000000000000003',
      'msg_00000000000000000000000004',
      'msg_00000000000000000000000005',
      'msg_00000000000000000000000006',
    ],
    parts: {
      // Root user message: single text part
      msg_00000000000000000000000001: [
        {
          id: 'prt_00000000000000000000000001',
          type: 'text',
          text: 'Build a sample project overview with two sections.',
        },
      ],
      // Root assistant message: step-start + text (snapshot wins over deltas) + 2 tool parts
      msg_00000000000000000000000002: [
        {
          id: 'prt_00000000000000000000000002',
          type: 'step-start',
        },
        {
          id: 'prt_00000000000000000000000003',
          type: 'text',
          text: '\n\nI will review the sample notes and directories, then prepare a project overview.',
        },
        {
          id: 'prt_00000000000000000000000004',
          type: 'tool',
          tool: 'task',
        },
        {
          id: 'prt_00000000000000000000000006',
          type: 'tool',
          tool: 'task',
        },
      ],
      // Child 1 user message: single text part
      msg_00000000000000000000000003: [
        {
          id: 'prt_00000000000000000000000005',
          type: 'text',
          text: 'Read the sample notes and summarize their contents.',
        },
      ],
      // Child 1 assistant message: no parts in this excerpt (assistant msg created but no parts yet)
      msg_00000000000000000000000004: [],
      // Child 2 user message: single text part
      msg_00000000000000000000000005: [
        {
          id: 'prt_00000000000000000000000007',
          type: 'text',
          text: 'List the sample directories and summarize their layout.',
        },
      ],
      // Child 2 assistant message: no parts in this excerpt
      msg_00000000000000000000000006: [],
    },
  },
};

export { sessionReplay };
