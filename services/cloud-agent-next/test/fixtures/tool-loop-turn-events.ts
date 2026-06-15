import type { IngestEvent } from '../../src/websocket/types.js';

export type ToolLoopTurnFixture = {
  label: string;
  rootKiloSessionId: string;
  childKiloSessionId: string;
  userMessageId: string;
  intermediateAssistantMessageId: string;
  finalAssistantMessageId: string;
  finalText: string;
  eventsBeforeIdle: IngestEvent[];
  childIdle: IngestEvent;
  rootIdle: IngestEvent;
  wrapperComplete: IngestEvent;
};

type ToolLoopFixtureInput = {
  label: string;
  intermediateText?: string;
};

const ROOT_KILO_SESSION_ID = 'ses_synthetic_tool_loop_root';
const CHILD_KILO_SESSION_ID = 'ses_synthetic_tool_loop_child';
const BASE_TIME_MS = Date.now() - 60_000;

function timestamp(offsetMs: number): string {
  return new Date(BASE_TIME_MS + offsetMs).toISOString();
}

function kilocode(offsetMs: number, data: Record<string, unknown>): IngestEvent {
  return {
    streamEventType: 'kilocode',
    timestamp: timestamp(offsetMs),
    data,
  };
}

function createToolLoopTurnFixture(input: ToolLoopFixtureInput): ToolLoopTurnFixture {
  const suffix = input.label.replace(/[^a-z]/g, '_');
  const userMessageId =
    input.label === 'sonnet_preamble'
      ? 'msg_0123456789abSonnetUserAbCd'
      : 'msg_abcdef012345FreeToolUsrAbC';
  const intermediateAssistantMessageId = `msg_synthetic_${suffix}_intermediate`;
  const finalAssistantMessageId = `msg_synthetic_${suffix}_final`;
  const finalText = `Synthetic final answer for ${input.label}`;
  const intermediateParts: IngestEvent[] = [];

  if (input.intermediateText) {
    intermediateParts.push(
      kilocode(1_100, {
        event: 'message.part.updated',
        properties: {
          part: {
            id: `part_${suffix}_preamble`,
            messageID: intermediateAssistantMessageId,
            sessionID: ROOT_KILO_SESSION_ID,
            type: 'text',
            text: input.intermediateText,
          },
        },
      })
    );
  }

  intermediateParts.push(
    kilocode(1_200, {
      event: 'message.part.updated',
      properties: {
        part: {
          id: `part_${suffix}_tool`,
          messageID: intermediateAssistantMessageId,
          sessionID: ROOT_KILO_SESSION_ID,
          type: 'tool',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '/synthetic/read-only-input.txt' },
            output: 'sanitized placeholder output',
          },
        },
      },
    })
  );

  return {
    label: input.label,
    rootKiloSessionId: ROOT_KILO_SESSION_ID,
    childKiloSessionId: CHILD_KILO_SESSION_ID,
    userMessageId,
    intermediateAssistantMessageId,
    finalAssistantMessageId,
    finalText,
    eventsBeforeIdle: [
      kilocode(1_000, {
        event: 'message.updated',
        properties: {
          info: {
            id: intermediateAssistantMessageId,
            role: 'assistant',
            sessionID: ROOT_KILO_SESSION_ID,
            parentID: userMessageId,
            time: { completed: BASE_TIME_MS + 1_000 },
          },
        },
      }),
      ...intermediateParts,
      kilocode(2_000, {
        event: 'session.status',
        properties: {
          sessionID: ROOT_KILO_SESSION_ID,
          status: { type: 'busy' },
        },
      }),
      kilocode(3_000, {
        event: 'message.updated',
        properties: {
          info: {
            id: finalAssistantMessageId,
            role: 'assistant',
            sessionID: ROOT_KILO_SESSION_ID,
            parentID: userMessageId,
            time: { completed: BASE_TIME_MS + 3_000 },
          },
        },
      }),
      kilocode(3_100, {
        event: 'message.part.updated',
        properties: {
          part: {
            id: `part_${suffix}_final_text`,
            messageID: finalAssistantMessageId,
            sessionID: ROOT_KILO_SESSION_ID,
            type: 'text',
            text: finalText,
          },
        },
      }),
    ],
    childIdle: kilocode(4_000, {
      event: 'session.idle',
      properties: { sessionID: CHILD_KILO_SESSION_ID },
    }),
    rootIdle: kilocode(5_000, {
      event: 'session.idle',
      properties: { sessionID: ROOT_KILO_SESSION_ID },
    }),
    wrapperComplete: {
      streamEventType: 'complete',
      timestamp: timestamp(6_000),
      data: { exitCode: 0, messageIds: [userMessageId] },
    },
  };
}

// Reconstructed and sanitized from production-shaped tool-loop timelines. These
// fixtures contain no raw SDK archive events or production-specific values.
export const reconstructedToolLoopTurnFixtures = [
  createToolLoopTurnFixture({
    label: 'sonnet_preamble',
    intermediateText: 'I will inspect the synthetic workspace before answering.',
  }),
  createToolLoopTurnFixture({ label: 'free_tool_only' }),
] satisfies ToolLoopTurnFixture[];

export const productionFixtureDenylist = [
  /agent_[0-9a-f]{8}-[0-9a-f-]{27,}/,
  /ses_[a-z0-9]{20,}/i,
  /msg_e8d[a-z0-9]+/i,
  /wr_[0-9a-f]{32}/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bBearer\s+\S+/i,
  /\/Users\/[^/]+\//,
  /na2-org\//,
  /\/tmp\/cloud-agent-cli-logs\//,
] as const;
