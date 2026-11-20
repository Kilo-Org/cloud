/**
 * Negative type cases for the split between the generated OpenCode types and
 * the hand-written Kilo extensions. They are checked by `pnpm typecheck`, whose
 * tsconfig includes every TypeScript file.
 *
 * The generated module cannot be regenerated in this repository, so the guard
 * that matters is that it carries no hand edit: if one is added back, the
 * `@ts-expect-error` directives below become unused and the typecheck fails,
 * instead of a future regeneration silently deleting it.
 */
import type {
  FilePart as GeneratedFilePart,
  UserMessage as GeneratedUserMessage,
} from './opencode.gen';
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

// The hand-written extensions must stay reachable through the union and the
// event wrapper, not only on the hand-written entry.
const parts: Part[] = [filePlaceholder, completedTool];
const event: EventMessageUpdated = {
  id: 'e1',
  type: 'message.updated',
  properties: { sessionID: 'ses_1', info: user },
};
const message: Message = event.properties.info;
const unconfirmed = event.properties.info.role === 'user' && event.properties.info.synthetic;
const attachment = completedTool.state.status === 'completed' && completedTool.state.attachments;
const synthetic = Array.isArray(attachment) ? attachment[0]?.synthetic : undefined;

const readGenerated = (row: GeneratedUserMessage): void => {
  // @ts-expect-error the generated UserMessage carries no Kilo extension
  void row.synthetic;
  // @ts-expect-error the generated UserMessage carries no Kilo extension
  void row.queuedAt;
  // @ts-expect-error the generated UserMessage carries no Kilo extension
  void row.editorContext;
};
const readGeneratedFilePart = (part: GeneratedFilePart): void => {
  // @ts-expect-error the generated FilePart carries no Kilo extension
  void part.synthetic;
};

void parts;
void message;
void unconfirmed;
void synthetic;
void readGenerated;
void readGeneratedFilePart;
