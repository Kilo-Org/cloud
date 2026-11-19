/**
 * Negative type cases for the split between the generated OpenCode types and
 * the hand-written Kilo extensions. They are checked by `pnpm typecheck`, whose
 * tsconfig includes every TypeScript file; the runtime assertions only keep the
 * file meaningful to vitest.
 *
 * The generated module cannot be regenerated in this repository, so the guard
 * that matters is that it carries no hand edit: if one is added back, the
 * `@ts-expect-error` directives below become unused and the typecheck fails,
 * instead of a future regeneration silently deleting it.
 */
import { describe, expect, it } from 'vitest';

import type { UserMessage as GeneratedUserMessage } from './opencode.gen';
import type {
  EventMessageUpdated,
  FilePart,
  Message,
  Part,
  ToolPart,
  UserMessage,
} from './opencode';

const user: UserMessage = {
  id: 'm1',
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1 },
  agent: 'build',
  model: { providerID: 'p', modelID: 'm' },
  synthetic: true,
  queuedAt: 2,
  editorContext: { visibleFiles: ['a.ts'], shell: 'bash' },
};

const filePlaceholder: FilePart = {
  id: 'p1',
  sessionID: 'ses_1',
  messageID: 'm1',
  type: 'file',
  mime: 'image/png',
  url: '',
  synthetic: true,
};

const completedTool: ToolPart = {
  id: 'p2',
  sessionID: 'ses_1',
  messageID: 'm1',
  type: 'tool',
  callID: 'c1',
  tool: 'send_file',
  state: {
    status: 'completed',
    input: {},
    output: '',
    title: '',
    metadata: {},
    time: { start: 1, end: 2 },
    attachments: [filePlaceholder],
  },
};

describe('Kilo extension types', () => {
  it('declares the extensions on the hand-written entry', () => {
    const parts: Part[] = [filePlaceholder, completedTool];
    const event: EventMessageUpdated = {
      id: 'e1',
      type: 'message.updated',
      properties: { sessionID: 'ses_1', info: user },
    };
    const message: Message = event.properties.info;

    expect(parts).toHaveLength(2);
    expect(message).toBe(user);
    expect(user.editorContext?.shell).toBe('bash');
  });

  it('reaches the extension through the union and the event wrapper', () => {
    const event: EventMessageUpdated = {
      id: 'e1',
      type: 'message.updated',
      properties: { sessionID: 'ses_1', info: user },
    };
    // Compiles only while `EventMessageUpdated` carries the extended `Message`:
    // the generated wrapper speaks the generated (narrow) user message.
    const unconfirmed = event.properties.info.role === 'user' && event.properties.info.synthetic;

    expect(unconfirmed).toBe(true);
  });

  it('reaches the extension on a tool attachment', () => {
    const attachment =
      completedTool.state.status === 'completed' && completedTool.state.attachments;
    const synthetic = Array.isArray(attachment) ? attachment[0]?.synthetic : undefined;

    expect(synthetic).toBe(true);
  });

  it('keeps the hand-written extensions out of the generated module', () => {
    const readGenerated = (row: GeneratedUserMessage) => [
      // @ts-expect-error the generated UserMessage carries no Kilo extension
      row.synthetic,
      // @ts-expect-error the generated UserMessage carries no Kilo extension
      row.queuedAt,
      // @ts-expect-error the generated UserMessage carries no Kilo extension
      row.editorContext,
    ];

    expect(readGenerated).toBeTypeOf('function');
  });
});
