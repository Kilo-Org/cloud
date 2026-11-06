import type { AssistantMessage } from '@/types/opencode.gen';
import type { Part, StoredMessage, ToolPart } from '../../types';

const fixtureChildId = 'ses_00000000000000000000000000';
const sessionID = 'ses_fixture';
const time = 1793188800000;
export function fixtureAssistant(
  id: string,
  parts: Part[],
  overrides: Partial<AssistantMessage> = {}
): StoredMessage {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID,
      parentID: `user-${id}`,
      time: { created: time, completed: time + 1000 },
      modelID: 'fixture',
      providerID: 'fixture',
      mode: 'code',
      agent: 'code',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    },
    parts,
  };
}
export function fixtureText(id: string, text: string): Part {
  return { id, sessionID, messageID: 'fixture', type: 'text', text };
}
export function fixtureTool(
  tool: string,
  state: ToolPart['state']['status'] = 'completed',
  input: Record<string, unknown> = {
    filePath: '/workspace/app/example.ts',
    command: 'pnpm test',
    pattern: 'example',
    query: 'example',
    url: 'https://example.com',
    path: '/workspace/app',
    prompt: 'Check the result',
    id: 'task-1',
    action: 'list',
    todos: [{ id: 'todo-1', content: 'Inspect upload', status: 'completed', priority: 'medium' }],
    questions: [
      {
        header: 'Scope',
        question: 'Continue?',
        options: [{ label: 'Yes', description: 'Continue' }],
      },
    ],
    description: 'Inspect child session',
    subagent_type: 'code',
    name: 'review',
  }
): ToolPart {
  return {
    id: `${tool}-${state}`,
    type: 'tool',
    sessionID,
    messageID: 'fixture',
    tool,
    callID: `call-${tool}-${state}`,
    state:
      state === 'pending'
        ? { status: state, input, raw: JSON.stringify(input) }
        : state === 'running'
          ? {
              status: state,
              input,
              time: { start: time },
              metadata: { output: 'Streaming output', sessionId: fixtureChildId },
            }
          : state === 'error'
            ? {
                status: state,
                input,
                error: 'Controlled tool failure',
                time: { start: time, end: time + 1000 },
              }
            : {
                status: state,
                input,
                output: 'Controlled tool result',
                title: tool,
                time: { start: time, end: time + 1000 },
                metadata: { sessionId: fixtureChildId },
              },
  };
}
