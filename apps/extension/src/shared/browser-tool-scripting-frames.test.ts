/* eslint-disable require-await, typescript/require-await -- the fake frame reader is async by contract and answers at once */
import { describe, expect, it, vi } from 'vitest';
import type { IsolatedAgentProbe } from './browser-agent-isolated-probe';
import { spliceScriptingFrames } from './browser-tool-scripting-frames';
import type { ScriptingSnapshotPart } from './browser-tool-scripting-frames';

interface ProbedFrame {
  readonly origin: string;
  readonly owners: readonly (number | null)[];
  readonly parent?: number;
}

/** The `frame` probe's answer per frame id: its origin, its parent and the frame each owner element hosts. */
const probeOf =
  (frames: Record<number, ProbedFrame>): IsolatedAgentProbe =>
  async () =>
    Object.entries(frames).map(([id, frame]) => ({
      frameId: Number(id),
      result: JSON.stringify({
        origin: frame.origin,
        owners: frame.owners,
        parentFrameId: frame.parent ?? null,
        url: `${frame.origin}/`,
      }),
    }));

const MAIN: ScriptingSnapshotPart = {
  frames: [
    { depth: 1, line: 2, owner: 0 },
    { depth: 1, line: 3, owner: 1 },
  ],
  lines: ['- heading "Shop"[level=1]', '- main', '  - iframe [ref=e1]', '  - iframe [ref=e2]'],
};

const PROBE = probeOf({
  0: { origin: 'https://shop.example.com', owners: [4, 5] },
  4: { origin: 'https://pay.example.com', owners: [], parent: 0 },
  5: { origin: 'https://ads.example.com', owners: [], parent: 0 },
});

const PAY_FRAME: ScriptingSnapshotPart = {
  frames: [],
  lines: ['- textbox "Card"', '- text: PAY-MARKER'],
};

describe('scripting snapshot frame splice', () => {
  it('splices a readable frame under its line and withholds every other one', async () => {
    const readFrame = vi.fn(async (_frameId: number) => PAY_FRAME);

    await expect(
      spliceScriptingFrames(MAIN, undefined, {
        probe: PROBE,
        readFrame,
        readableOrigins: ['https://shop.example.com', 'https://pay.example.com'],
      })
    ).resolves.toStrictEqual([
      '- heading "Shop"[level=1]',
      '- main',
      '  - iframe [ref=e1]',
      '    - textbox "Card"',
      '    - text: PAY-MARKER',
      '  - iframe [ref=e2] [origin withheld: https://ads.example.com]',
    ]);
    // The withheld frame's document is never read.
    expect(readFrame.mock.calls.map(([frameId]) => frameId)).toStrictEqual([4]);
  });

  it('withholds a frame the probe cannot map, and reads nothing without grants', async () => {
    const readFrame = vi.fn(async () => PAY_FRAME);

    await expect(
      spliceScriptingFrames(MAIN, undefined, {
        probe: probeOf({ 0: { origin: 'https://shop.example.com', owners: [null] } }),
        readFrame,
        readableOrigins: ['https://shop.example.com'],
      })
    ).resolves.toStrictEqual([
      '- heading "Shop"[level=1]',
      '- main',
      '  - iframe [ref=e1] [origin withheld: unknown]',
      '  - iframe [ref=e2] [origin withheld: unknown]',
    ]);
    expect(readFrame).not.toHaveBeenCalled();
  });

  it('reads a granted frame only as deep as the snapshot depth still allows', async () => {
    const readFrame = vi.fn(async () => PAY_FRAME);

    await spliceScriptingFrames(MAIN, 3, {
      probe: PROBE,
      readFrame,
      readableOrigins: ['https://pay.example.com'],
    });
    await spliceScriptingFrames(MAIN, 1, {
      probe: PROBE,
      readFrame,
      readableOrigins: ['https://pay.example.com'],
    });

    // The frame's document starts two levels down: depth 3 leaves it one level, depth 1 none.
    expect(readFrame.mock.calls).toStrictEqual([[4, 1]]);
  });
});
