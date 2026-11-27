import {
  createPersistentTerminalProtocol,
  isPersistentTerminalGreeting,
  persistentTerminalFrame,
  type PersistentTerminalEffect,
} from './persistent-terminal-protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const snapshot = (checkpoint = 'screen') =>
  JSON.stringify({ type: 'snapshot', size: { cols: 80, rows: 24 }, checkpoint: btoa(checkpoint) });

const attached = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'attached',
    attachmentID: 'att_1',
    inputProtocol: 1,
    info: { size: { cols: 80, rows: 24 } },
    role: 'controller',
    ...fields,
  });

const REPLAY_COMPLETE = JSON.stringify({ type: 'replay_complete', endOffset: 97 });

function describeEffects(effects: PersistentTerminalEffect[]) {
  return effects.map(effect => {
    if (effect.type === 'write') return { write: decoder.decode(effect.data) };
    if (effect.type === 'send') {
      const view = new DataView(effect.frame.buffer);
      return {
        send: {
          input: effect.frame[0] === 1,
          cols: view.getUint16(1),
          rows: view.getUint16(3),
          data: decoder.decode(effect.frame.subarray(5)),
        },
      };
    }
    return effect;
  });
}

function attach() {
  const protocol = createPersistentTerminalProtocol();
  protocol.message(snapshot());
  protocol.message(attached());
  return protocol;
}

describe('isPersistentTerminalGreeting', () => {
  it('recognizes only the wrapper snapshot', () => {
    expect(isPersistentTerminalGreeting(snapshot())).toBe(true);
    expect(isPersistentTerminalGreeting('\u0000{"cursor":1}')).toBe(false);
    expect(isPersistentTerminalGreeting('{"type":"snapshot"}')).toBe(false);
    expect(isPersistentTerminalGreeting('$ ')).toBe(false);
    expect(isPersistentTerminalGreeting(new ArrayBuffer(4))).toBe(false);
  });
});

describe('persistentTerminalFrame', () => {
  it('encodes the size in big-endian before the input', () => {
    expect([...persistentTerminalFrame({ cols: 300, rows: 40 }, encoder.encode('a'))]).toEqual([
      1, 1, 44, 0, 40, 97,
    ]);
    expect([...persistentTerminalFrame({ cols: 80, rows: 24 })]).toEqual([0, 0, 80, 0, 24]);
  });
});

describe('createPersistentTerminalProtocol', () => {
  it('restores the screen after a reset, at the snapshot size', () => {
    const protocol = createPersistentTerminalProtocol();
    expect(describeEffects(protocol.message(snapshot('$ ls\r\n')))).toEqual([
      { type: 'resize', size: { cols: 80, rows: 24 } },
      { write: '\x1bc$ ls\r\n' },
    ]);
    expect(describeEffects(protocol.message(attached()))).toEqual([
      { type: 'resize', size: { cols: 80, rows: 24 } },
    ]);
  });

  it('holds input during the replay, then sends it at the pane size', () => {
    const protocol = attach();
    protocol.size({ cols: 100, rows: 30 });
    expect(protocol.input(encoder.encode('ls\r'))).toEqual([]);
    expect(describeEffects(protocol.message(REPLAY_COMPLETE))).toEqual([
      { send: { input: true, cols: 100, rows: 30, data: 'ls\r' } },
    ]);
    expect(describeEffects(protocol.input(encoder.encode('pwd\r')))).toEqual([
      { send: { input: true, cols: 100, rows: 30, data: 'pwd\r' } },
    ]);
  });

  it('takes control at the pane size when the replay ends without input', () => {
    const protocol = attach();
    protocol.size({ cols: 100, rows: 30 });
    expect(describeEffects(protocol.message(REPLAY_COMPLETE))).toEqual([
      { send: { input: false, cols: 100, rows: 30, data: '' } },
    ]);
  });

  it('waits for the first pane size before it sends held input', () => {
    const protocol = attach();
    protocol.message(REPLAY_COMPLETE);
    expect(protocol.input(encoder.encode('a'))).toEqual([]);
    expect(describeEffects(protocol.size({ cols: 90, rows: 20 }))).toEqual([
      { send: { input: true, cols: 90, rows: 20, data: 'a' } },
    ]);
  });

  it('sends a size frame for a new pane size and applies the canonical resize', () => {
    const protocol = attach();
    protocol.size({ cols: 100, rows: 30 });
    protocol.message(REPLAY_COMPLETE);
    expect(protocol.size({ cols: 100, rows: 30 })).toEqual([]);
    expect(describeEffects(protocol.size({ cols: 120, rows: 40 }))).toEqual([
      { send: { input: false, cols: 120, rows: 40, data: '' } },
    ]);
    const resized = JSON.stringify({
      type: 'resized',
      cols: 120,
      rows: 40,
      generation: 2,
      checkpoint: btoa('wide'),
    });
    expect(describeEffects(protocol.message(resized))).toEqual([
      { type: 'resize', size: { cols: 120, rows: 40 } },
      { write: '\x1bcwide' },
    ]);
  });

  it('splits large input into bounded frames', () => {
    const protocol = attach();
    protocol.size({ cols: 80, rows: 24 });
    protocol.message(REPLAY_COMPLETE);
    const effects = protocol.input(new Uint8Array(150 * 1024).fill(97));
    expect(effects).toHaveLength(3);
    expect(
      effects.map(effect => (effect.type === 'send' ? effect.frame.byteLength - 5 : 0))
    ).toEqual([64 * 1024, 64 * 1024, 22 * 1024]);
  });

  it('does not send input or resize while another attachment controls the PTY', () => {
    const protocol = attach();
    protocol.size({ cols: 80, rows: 24 });
    protocol.message(REPLAY_COMPLETE);
    expect(
      protocol.message(JSON.stringify({ type: 'controller_changed', attachmentID: 'att_2' }))
    ).toEqual([]);
    expect(protocol.input(encoder.encode('a'))).toEqual([]);
    expect(protocol.size({ cols: 120, rows: 32 })).toEqual([]);
    expect(
      describeEffects(
        protocol.message(JSON.stringify({ type: 'controller_changed', attachmentID: 'att_1' }))
      )
    ).toEqual([{ send: { input: false, cols: 120, rows: 32, data: '' } }]);
  });

  it('does not flush input or size when replay completes as an observer', () => {
    const protocol = createPersistentTerminalProtocol();
    protocol.message(snapshot());
    protocol.size({ cols: 90, rows: 30 });
    protocol.input(encoder.encode('a'));
    protocol.message(attached({ role: 'observer' }));
    expect(protocol.message(REPLAY_COMPLETE)).toEqual([]);
  });

  it('fails an attachment without the size-prefixed input protocol', () => {
    const protocol = createPersistentTerminalProtocol();
    protocol.message(snapshot());
    expect(protocol.message(attached({ inputProtocol: undefined }))).toEqual([
      { type: 'outdated' },
    ]);
    expect(protocol.acceptsOutput()).toBe(false);
    expect(protocol.input(encoder.encode('a'))).toEqual([]);
  });

  it('stops input after the shell exits but still shows its last output', () => {
    const protocol = attach();
    protocol.size({ cols: 80, rows: 24 });
    protocol.message(REPLAY_COMPLETE);
    expect(protocol.message(JSON.stringify({ type: 'exited', exitCode: 0 }))).toEqual([
      { type: 'exited' },
    ]);
    expect(protocol.hasExited()).toBe(true);
    expect(protocol.input(encoder.encode('a'))).toEqual([]);
    expect(protocol.acceptsOutput()).toBe(true);
  });

  it('ignores unknown and malformed messages', () => {
    const protocol = attach();
    expect(protocol.message('{"type":"title_changed","title":"bash"}')).toEqual([]);
    expect(protocol.message('not json')).toEqual([]);
  });
});
