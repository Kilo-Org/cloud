/* eslint-disable require-await, typescript/require-await -- the fake frame reader is async by contract and answers at once */
import { describe, expect, it, vi } from 'vitest';
import { readIsolatedFrames } from './browser-agent-isolated-probe';
import type { IsolatedAgentProbe } from './browser-agent-isolated-probe';
import {
  MAX_SCRIPTING_FRAME_READS,
  SCRIPTING_FRAME_READS_DEADLINE_MS,
  spliceScriptingFrames,
} from './browser-tool-scripting-frames';
import type { ScriptingFrameScope, ScriptingSnapshotPart } from './browser-tool-scripting-frames';
import { MAX_BROWSER_TOOL_SNAPSHOT_LINES } from './browser-tool-snapshot';

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
    { depth: 1, line: 2, owner: 0, ref: 'e1' },
    { depth: 1, line: 3, owner: 1, ref: 'e2' },
  ],
  lines: ['- heading "Shop"[level=1]', '- main', '  - iframe [ref=e1]', '  - iframe [ref=e2]'],
  refs: [
    { ref: 'e1', selector: 'main > iframe:nth-of-type(1)' },
    { ref: 'e2', selector: 'main > iframe:nth-of-type(2)' },
  ],
};

const PROBE = probeOf({
  0: { origin: 'https://shop.example.com', owners: [4, 5] },
  4: { origin: 'https://pay.example.com', owners: [], parent: 0 },
  5: { origin: 'https://ads.example.com', owners: [], parent: 0 },
});

const PAY_FRAME: ScriptingSnapshotPart = {
  frames: [],
  lines: ['- textbox "Card" [ref=e3]', '- text: PAY-MARKER'],
  refs: [{ ref: 'e3', selector: 'body > input' }],
};

const scopeOf = (
  probe: IsolatedAgentProbe,
  readFrame: ScriptingFrameScope['readFrame'],
  readableOrigins: readonly string[]
): ScriptingFrameScope => ({
  frameTree: () => readIsolatedFrames(probe),
  readFrame,
  readableOrigins,
  rootFrameId: 0,
});

/** A page with `count` granted frames, one line each. */
const manyFrames = (count: number) => {
  const ids = Array.from({ length: count }, (_slot, index) => 10 + index);

  return {
    main: {
      frames: ids.map((_id, index) => ({
        depth: 0,
        line: index,
        owner: index,
        ref: `e${index + 1}`,
      })),
      lines: ids.map((_id, index) => `- iframe [ref=e${index + 1}]`),
      refs: [],
    },
    probe: probeOf({
      0: { origin: 'https://shop.example.com', owners: ids },
      ...Object.fromEntries(
        ids.map(id => [id, { origin: 'https://pay.example.com', owners: [], parent: 0 }])
      ),
    }),
  };
};

describe('scripting snapshot frame splice', () => {
  it('splices a readable frame under its line and withholds every other one', async () => {
    const readFrame = vi.fn(async (_frameId: number) => PAY_FRAME);

    await expect(
      spliceScriptingFrames(
        MAIN,
        undefined,
        scopeOf(PROBE, readFrame, ['https://shop.example.com', 'https://pay.example.com'])
      )
    ).resolves.toStrictEqual({
      lines: [
        '- heading "Shop"[level=1]',
        '- main',
        '  - iframe',
        '    - textbox "Card" [ref=e3]',
        '    - text: PAY-MARKER',
        '  - iframe [ref=e2] [origin withheld: https://ads.example.com]',
      ],
      // A click on a spliced frame's line would only reach the owner element; the withheld one keeps its ref for a read request.
      readableFrameRefs: ['e1'],
      refs: [{ frameId: 4, ref: 'e3', selector: 'body > input' }],
    });
    // The withheld frame's document is never read.
    expect(readFrame.mock.calls.map(([frameId]) => frameId)).toStrictEqual([4]);
  });

  it('withholds a frame the probe cannot map, and reads nothing without grants', async () => {
    const readFrame = vi.fn(async () => PAY_FRAME);

    await expect(
      spliceScriptingFrames(
        MAIN,
        undefined,
        scopeOf(probeOf({ 0: { origin: 'https://shop.example.com', owners: [null] } }), readFrame, [
          'https://shop.example.com',
        ])
      )
    ).resolves.toStrictEqual({
      lines: [
        '- heading "Shop"[level=1]',
        '- main',
        '  - iframe [ref=e1] [origin withheld: unknown]',
        '  - iframe [ref=e2] [origin withheld: unknown]',
      ],
      readableFrameRefs: [],
      refs: [],
    });
    expect(readFrame).not.toHaveBeenCalled();
  });

  it('reads a granted frame only as deep as the snapshot depth still allows', async () => {
    const readFrame = vi.fn(async (_frameId: number, _maxDepth: number | undefined) => PAY_FRAME);
    const scope = scopeOf(PROBE, readFrame, ['https://pay.example.com']);

    await spliceScriptingFrames(MAIN, 3, scope);
    await spliceScriptingFrames(MAIN, 1, scope);

    // The frame's document starts two levels down: depth 3 leaves it one level, depth 1 none.
    expect(readFrame.mock.calls.map(([frameId, maxDepth]) => [frameId, maxDepth])).toStrictEqual([
      [4, 1],
    ]);
  });

  it('withholds a granted frame whose read fails, leaking no content', async () => {
    await expect(
      spliceScriptingFrames(
        MAIN,
        undefined,
        scopeOf(PROBE, vi.fn<ScriptingFrameScope['readFrame']>(), ['https://pay.example.com'])
      )
    ).resolves.toStrictEqual({
      lines: [
        '- heading "Shop"[level=1]',
        '- main',
        '  - iframe [ref=e1] [origin withheld: https://pay.example.com]',
        '  - iframe [ref=e2] [origin withheld: https://ads.example.com]',
      ],
      readableFrameRefs: [],
      refs: [],
    });
  });

  it('reads at most the frame cap and withholds the rest', async () => {
    const { main, probe } = manyFrames(MAX_SCRIPTING_FRAME_READS + 2);
    const readFrame = vi.fn(async () => PAY_FRAME);

    const { lines } = await spliceScriptingFrames(
      main,
      undefined,
      scopeOf(probe, readFrame, ['https://pay.example.com'])
    );

    expect(readFrame).toHaveBeenCalledTimes(MAX_SCRIPTING_FRAME_READS);
    expect(lines.slice(-2)).toStrictEqual([
      `- iframe [ref=e${MAX_SCRIPTING_FRAME_READS + 1}] [origin withheld: https://pay.example.com]`,
      `- iframe [ref=e${MAX_SCRIPTING_FRAME_READS + 2}] [origin withheld: https://pay.example.com]`,
    ]);
  });

  it('shares one deadline across every frame read', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });

    const { main, probe } = manyFrames(3);
    const readFrame = vi.fn(
      async (_frameId: number, _depth: number | undefined, _timeout: number) => {
        vi.setSystemTime(Date.now() + SCRIPTING_FRAME_READS_DEADLINE_MS / 2 + 1);

        return PAY_FRAME;
      }
    );

    const { lines } = await spliceScriptingFrames(
      main,
      undefined,
      scopeOf(probe, readFrame, ['https://pay.example.com'])
    );
    vi.useRealTimers();
    expect(readFrame.mock.calls.map(call => call[2])).toStrictEqual([
      SCRIPTING_FRAME_READS_DEADLINE_MS,
      SCRIPTING_FRAME_READS_DEADLINE_MS / 2 - 1,
    ]);
    expect(lines.at(-1)).toBe('- iframe [ref=e3] [origin withheld: https://pay.example.com]');
  });

  it('caps the spliced snapshot at the debugger path’s line limit', async () => {
    const { main, probe } = manyFrames(2);
    const huge: ScriptingSnapshotPart = {
      frames: [],
      lines: Array.from({ length: MAX_BROWSER_TOOL_SNAPSHOT_LINES + 10 }, () => '- text: x'),
      refs: [],
    };
    const readFrame = vi.fn(async (_frameId: number) => huge);

    const { lines } = await spliceScriptingFrames(
      main,
      undefined,
      scopeOf(probe, readFrame, ['https://pay.example.com'])
    );

    expect(lines).toHaveLength(MAX_BROWSER_TOOL_SNAPSHOT_LINES + 1);
    expect(lines.at(-1)).toBe(
      `... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`
    );
    // The line budget is spent by the first frame, so the second is not read.
    expect(readFrame.mock.calls.map(([frameId]) => frameId)).toStrictEqual([10]);
  });

  it('splices the child frames of the frame a targeted snapshot starts in', async () => {
    const readFrame = vi.fn(async () => PAY_FRAME);
    const inPay: ScriptingSnapshotPart = {
      frames: [{ depth: 0, line: 1, owner: 0, ref: 'e9' }],
      lines: ['- button "Pay" [ref=e8]', '- iframe [ref=e9]'],
      refs: [],
    };

    await expect(
      spliceScriptingFrames(inPay, undefined, {
        ...scopeOf(
          probeOf({
            0: { origin: 'https://shop.example.com', owners: [4] },
            4: { origin: 'https://pay.example.com', owners: [6], parent: 0 },
            6: { origin: 'https://pay.example.com', owners: [], parent: 4 },
          }),
          readFrame,
          ['https://pay.example.com']
        ),
        rootFrameId: 4,
      })
    ).resolves.toStrictEqual({
      lines: [
        '- button "Pay" [ref=e8]',
        '- iframe',
        '  - textbox "Card" [ref=e3]',
        '  - text: PAY-MARKER',
      ],
      readableFrameRefs: ['e9'],
      refs: [{ frameId: 6, ref: 'e3', selector: 'body > input' }],
    });
  });
});
