import { readKilo2Messages } from '@kilocode/cloud-agent-sdk/kilo2-source-messages';
import { groupAssistantParts } from './shared-transcript-presentation';
import { getVisibleAssistantParts } from './message-presentation';

test('background result rows remain visible when tools are collapsed', () => {
  const messages = readKilo2Messages(
    { id: 'ses_root', location: { directory: '/workspace/app' }, time: { created: 1, updated: 2 } },
    [
      {
        id: 'msg_result',
        type: 'synthetic',
        description: 'Run tests',
        time: { created: 3 },
        text: '<shell id="sh_test" state="completed" command="pnpm test">\nTests failed\n</shell>',
        metadata: { source: 'shell', shellID: 'sh_test', state: 'completed', exit: 7 },
      },
    ]
  );
  const parts = getVisibleAssistantParts(messages[0]?.parts ?? []);
  expect(parts).toHaveLength(1);
  expect(groupAssistantParts(parts, 'live')).toEqual([{ type: 'chat', parts }]);
});
