import * as z from 'zod';

/**
 * The browser side of Kilo v2's persistent PTY protocol, after OpenCode's GUI
 * terminal. Each connection starts with the wrapper's `snapshot` (the screen
 * as a checkpoint), then the PTY service's `attached`, the replay since the
 * snapshot and `replay_complete`. Input goes live after the replay, in frames
 * that carry this pane's size; a frame at a new size resizes the PTY, which
 * answers with `resized` and a checkpoint at the canonical size.
 */

export type TerminalSize = { cols: number; rows: number };

export type PersistentTerminalEffect =
  /** Resize the emulator to the PTY's canonical size. */
  | { type: 'resize'; size: TerminalSize }
  /** Write terminal output, such as a checkpoint after a reset. */
  | { type: 'write'; data: Uint8Array }
  | { type: 'send'; frame: Uint8Array<ArrayBuffer> }
  | { type: 'exited' }
  /** The PTY service does not speak the size-prefixed input protocol. */
  | { type: 'outdated' };

const INPUT_PROTOCOL = 1;
const MAX_FRAME_DATA_BYTES = 64 * 1024;
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const RESET = '\x1bc';

const sizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), size: sizeSchema, checkpoint: z.string() }),
  z.object({
    type: z.literal('attached'),
    attachmentID: z.string().optional(),
    inputProtocol: z.number().optional(),
    info: z.object({ size: sizeSchema }),
    role: z.enum(['controller', 'observer']).optional(),
  }),
  z.object({ type: z.literal('replay_complete') }),
  z.object({
    type: z.literal('resized'),
    cols: z.number(),
    rows: z.number(),
    checkpoint: z.string(),
  }),
  z.object({ type: z.literal('controller_changed'), attachmentID: z.string().nullish() }),
  z.object({ type: z.literal('exited') }),
]);

type Message = z.infer<typeof messageSchema>;

function parseMessage(text: string): Message | undefined {
  try {
    const result = messageSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a connection's first message opens the persistent PTY protocol. */
export function isPersistentTerminalGreeting(data: string | ArrayBuffer): boolean {
  return typeof data === 'string' && parseMessage(data)?.type === 'snapshot';
}

export function persistentTerminalFrame(
  size: TerminalSize,
  data?: Uint8Array
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5 + (data?.byteLength ?? 0));
  const view = new DataView(frame.buffer);
  frame[0] = data ? 1 : 0;
  view.setUint16(1, size.cols);
  view.setUint16(3, size.rows);
  if (data) frame.set(data, 5);
  return frame;
}

/** A base64 checkpoint, after a reset: the emulator outlives one connection. */
function checkpointOutput(checkpoint: string): Uint8Array {
  return Uint8Array.from(RESET + atob(checkpoint), char => char.charCodeAt(0));
}

type State =
  | { status: 'restoring'; desired?: TerminalSize; pending: Uint8Array[] }
  | {
      status: 'replaying';
      attachmentId?: string;
      controller: boolean;
      desired?: TerminalSize;
      pending: Uint8Array[];
    }
  | {
      status: 'live';
      attachmentId?: string;
      controller: boolean;
      size?: TerminalSize;
      pending: Uint8Array[];
    }
  | { status: 'exited' | 'outdated' };

function sameSize(left: TerminalSize | undefined, right: TerminalSize): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

function inputFrames(size: TerminalSize, data: Uint8Array): PersistentTerminalEffect[] {
  const effects: PersistentTerminalEffect[] = [];
  for (let offset = 0; offset < data.byteLength; offset += MAX_FRAME_DATA_BYTES) {
    const chunk = data.subarray(offset, offset + MAX_FRAME_DATA_BYTES);
    effects.push({ type: 'send', frame: persistentTerminalFrame(size, chunk) });
  }
  return effects;
}

function hold(pending: Uint8Array[], data: Uint8Array): Uint8Array[] {
  const held = pending.reduce((total, chunk) => total + chunk.byteLength, 0);
  return held + data.byteLength > MAX_PENDING_INPUT_BYTES ? pending : [...pending, data];
}

/**
 * Input held until the controlling pane had a size, or else a size frame.
 */
function goLive(size: TerminalSize, pending: Uint8Array[]): PersistentTerminalEffect[] {
  if (pending.length === 0) return [{ type: 'send', frame: persistentTerminalFrame(size) }];
  return pending.flatMap(data => inputFrames(size, data));
}

export function createPersistentTerminalProtocol() {
  let state: State = { status: 'restoring', pending: [] };

  function receive(message: Message): PersistentTerminalEffect[] {
    if (message.type === 'snapshot') {
      if (state.status !== 'restoring') return [];
      return [
        { type: 'resize', size: message.size },
        { type: 'write', data: checkpointOutput(message.checkpoint) },
      ];
    }

    if (message.type === 'attached') {
      if (state.status !== 'restoring') return [];
      if (message.inputProtocol !== INPUT_PROTOCOL) {
        state = { status: 'outdated' };
        return [{ type: 'outdated' }];
      }
      state = {
        status: 'replaying',
        attachmentId: message.attachmentID,
        controller: message.role === 'controller',
        desired: state.desired,
        pending: message.role === 'controller' ? state.pending : [],
      };
      return [{ type: 'resize', size: message.info.size }];
    }

    if (state.status !== 'replaying' && state.status !== 'live') return [];

    if (message.type === 'resized') {
      const size = { cols: message.cols, rows: message.rows };
      return [
        { type: 'resize', size },
        { type: 'write', data: checkpointOutput(message.checkpoint) },
      ];
    }

    if (message.type === 'exited') {
      state = { status: 'exited' };
      return [{ type: 'exited' }];
    }

    if (message.type === 'replay_complete') {
      if (state.status !== 'replaying') return [];
      const { attachmentId, controller, desired, pending } = state;
      if (!desired) {
        state = { status: 'live', attachmentId, controller, pending };
        return [];
      }
      state = { status: 'live', attachmentId, controller, size: desired, pending: [] };
      return controller ? goLive(desired, pending) : [];
    }

    if (message.type !== 'controller_changed') return [];
    const controller = message.attachmentID != null && message.attachmentID === state.attachmentId;
    if (controller === state.controller) return [];
    state = { ...state, controller, pending: [] };
    return state.status === 'live' && controller && state.size
      ? [{ type: 'send', frame: persistentTerminalFrame(state.size) }]
      : [];
  }

  return {
    message(text: string): PersistentTerminalEffect[] {
      const message = parseMessage(text);
      return message ? receive(message) : [];
    },

    /** Encoded user input, without the replies the emulator makes while writing. */
    input(data: Uint8Array): PersistentTerminalEffect[] {
      if (data.byteLength === 0) return [];
      if (state.status !== 'restoring' && (!('controller' in state) || !state.controller))
        return [];
      if (state.status === 'restoring' || state.status === 'replaying') {
        state = { ...state, pending: hold(state.pending, data) };
        return [];
      }
      if (state.status !== 'live') return [];
      if (state.size) return inputFrames(state.size, data);
      state = { ...state, pending: hold(state.pending, data) };
      return [];
    },

    /** The pane's measured size, which this attachment asks the PTY to take. */
    size(size: TerminalSize): PersistentTerminalEffect[] {
      if (size.cols <= 0 || size.rows <= 0) return [];
      if (state.status === 'restoring' || state.status === 'replaying') {
        if (!sameSize(state.desired, size)) state = { ...state, desired: size };
        return [];
      }
      if (state.status !== 'live' || sameSize(state.size, size)) return [];
      const first = state.size === undefined;
      const pending = state.pending;
      state = { ...state, size, pending: [] };
      if (!state.controller) return [];
      return first
        ? goLive(size, pending)
        : [{ type: 'send', frame: persistentTerminalFrame(size) }];
    },

    /** Output still reaches the screen until the attachment fails; an exited shell's last output too. */
    acceptsOutput(): boolean {
      return state.status !== 'outdated';
    },

    hasExited(): boolean {
      return state.status === 'exited';
    },
  };
}

export type PersistentTerminalProtocol = ReturnType<typeof createPersistentTerminalProtocol>;
