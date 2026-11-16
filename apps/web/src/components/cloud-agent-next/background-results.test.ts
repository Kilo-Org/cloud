import { readKilo2Messages } from '@kilocode/cloud-agent-sdk/kilo2-source-messages';
import { groupAssistantParts } from './shared-transcript-presentation';
import { getVisibleAssistantParts } from './message-presentation';

const session = {
  id: 'ses_root',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
};

function instructionNotice() {
  return {
    id: 'msg_notice',
    type: 'synthetic',
    description: 'Loaded services/AGENTS.md',
    time: { created: 6 },
    text: 'Instructions from: /workspace/app/services/AGENTS.md',
    metadata: { instruction: { paths: ['/workspace/app/services/AGENTS.md'] } },
  };
}

test('background result rows remain visible when tools are collapsed', () => {
  const messages = readKilo2Messages(session, [
    {
      id: 'msg_result',
      type: 'synthetic',
      description: 'Run tests',
      time: { created: 3 },
      text: '<shell id="sh_test" state="completed" command="pnpm test">\nTests failed\n</shell>',
      metadata: { source: 'shell', shellID: 'sh_test', state: 'completed', exit: 7 },
    },
  ]);
  const parts = getVisibleAssistantParts(messages[0]?.parts ?? []);
  expect(parts).toHaveLength(1);
  expect(groupAssistantParts(parts, 'live')).toEqual([{ type: 'chat', parts }]);
});

test('agent notices stay inside the collapsed work group', () => {
  const messages = readKilo2Messages(session, [instructionNotice()]);
  const parts = getVisibleAssistantParts(messages[0]?.parts ?? []);
  expect(parts).toHaveLength(1);
  expect(groupAssistantParts(parts, 'live')).toEqual([
    { type: 'agent-work', parts, summary: '1 tool call' },
  ]);
});

test('a notice after tool work joins the same group and counts toward the summary', () => {
  const messages = readKilo2Messages(session, [
    {
      id: 'msg_work',
      type: 'assistant',
      time: { created: 2, completed: 5 },
      content: [
        {
          type: 'tool',
          id: 'call_1',
          name: 'shell',
          time: { created: 2, ran: 1000, completed: 4000 },
          state: {
            status: 'completed',
            input: { command: 'pnpm test' },
            content: [{ type: 'text', text: 'Tests passed' }],
          },
        },
      ],
    },
    instructionNotice(),
  ]);
  const parts = getVisibleAssistantParts(messages.flatMap(message => message.parts));
  expect(parts).toHaveLength(2);
  expect(groupAssistantParts(parts, 'live')).toEqual([
    { type: 'agent-work', parts, summary: 'Worked for 3s · 2 tool calls' },
  ]);
});
