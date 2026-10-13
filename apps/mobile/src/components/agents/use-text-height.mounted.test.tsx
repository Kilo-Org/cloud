import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTextHeight } from './use-text-height';

// vitest hoists this above the imports; the hook only needs host components.
vi.mock('react-native', () => ({
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

// The composer's own geometry: a 44pt one-line floor, a 124pt hard cap, 24pt of
// vertical padding around the text, and a requested 20pt line height.
const OPTIONS = {
  fontSize: 16,
  fontScale: 1,
  lineHeight: 20,
  maxHeight: 124,
  minHeight: 44,
  textContentWidth: 200,
  verticalPadding: 24,
};

type Published = { height: number; maxHeight: number };

let published: Published = { height: 0, maxHeight: 0 };
let reportContentSize: ((contentHeight: number) => void) | null = null;
let harnessRenders = 0;
let cap = OPTIONS.maxHeight;

function Harness() {
  harnessRenders += 1;
  const measure = useTextHeight({ ...OPTIONS, maxHeight: cap });
  published = { height: measure.height, maxHeight: measure.maxHeight };
  reportContentSize = measure.setNativeContentHeight;
  return measure.measureElement;
}

async function mount(capOverride?: number) {
  published = { height: 0, maxHeight: 0 };
  reportContentSize = null;
  harnessRenders = 0;
  cap = capOverride ?? OPTIONS.maxHeight;
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(Harness));
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/**
 * The input's `onContentSizeChange` report, in dp, padding included. The hook
 * records it only when the pitch it implies moves, so this returns the render
 * count as it was before the report, letting a caller assert whether the report
 * cost a render.
 */
function reportNativeContentSize(height: number): number {
  const before = harnessRenders;
  act(() => {
    reportContentSize?.(height);
  });
  return harnessRenders - before;
}

/** The hidden mirror's measured text height, before the padding is added. */
function layoutMirror(renderer: TestRenderer.ReactTestRenderer, textHeight: number) {
  const mirror = renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      typeof node.props.onLayout === 'function'
  );
  const layout = mirror.props.onLayout as (event: {
    nativeEvent: { layout: { height: number; width: number } };
  }) => void;
  act(() => {
    layout({ nativeEvent: { layout: { height: textHeight, width: 200 } } });
  });
}

describe('useTextHeight pitch snapping', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('keeps the cap raw until the input reports its content height', async () => {
    const renderer = await mount();
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBe(124);
    renderer.unmount();
  });

  it('snaps the cap down to the pitch the input actually renders (Android ignores lineHeight)', async () => {
    const renderer = await mount();
    // Roboto's natural line box at 16dp without font padding: 18.67dp per
    // line, over the mirror's six 20dp lines. floor((124 - 24) / 18.67) = 5.
    reportNativeContentSize(24 + 6 * 18.667);
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBeCloseTo(24 + 5 * 18.667, 2);
    renderer.unmount();
  });

  it('clamps the published height to the snapped cap, not the raw cap', async () => {
    const renderer = await mount();
    reportNativeContentSize(24 + 6 * 18.667);
    // The mirror honors the requested 20pt line height: six lines measure 120.
    layoutMirror(renderer, 120);
    expect(published.height).toBeCloseTo(24 + 5 * 18.667, 2);
    renderer.unmount();
  });

  it('keeps a cap that lands on the minimum a whole native line', async () => {
    // The smallest remaining-space cap is the caller's 44pt minimum, which is
    // a requested 20pt line box rather than a native one. Publishing it as is
    // would scroll a two-line draft by 17.33 - a partial line - and clip the
    // first visible line again, so the floor is snapped to the same pitch.
    const renderer = await mount(44);
    reportNativeContentSize(24 + 6 * 18.667);
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBeCloseTo(24 + 18.667, 2);
    expect(published.height).toBeCloseTo(24 + 18.667, 2);
    renderer.unmount();
  });

  it('never snaps the cap past the space the composer has', async () => {
    // A reported pitch (24dp) above the requested line box cannot fit a whole
    // native line in the 44dp cap: the cap stays the caller's own, inflated by
    // neither the snap nor the pitch-aligned floor.
    const renderer = await mount(44);
    reportNativeContentSize(24 + 6 * 24);
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBe(44);
    expect(published.height).toBe(44);
    renderer.unmount();
  });

  it('leaves an under-cap height untouched by the snap', async () => {
    const renderer = await mount();
    reportNativeContentSize(24 + 6 * 18.667);
    layoutMirror(renderer, 80);
    expect(published.height).toBe(104);
    renderer.unmount();
  });

  it('is a no-op where the input renders the requested line height (iOS)', async () => {
    const renderer = await mount();
    reportNativeContentSize(24 + 6 * 20);
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBe(124);
    expect(published.height).toBe(124);
    renderer.unmount();
  });

  it('ignores a report whose inferred pitch leaves the plausible band', async () => {
    const renderer = await mount();
    reportNativeContentSize(24 + 6 * 40);
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBe(124);
    renderer.unmount();
  });

  it('ignores a degenerate report that does not clear the padding', async () => {
    const renderer = await mount();
    reportNativeContentSize(10);
    layoutMirror(renderer, 120);
    expect(published.maxHeight).toBe(124);
    renderer.unmount();
  });

  it('drops a report that keeps the pitch at the line count it was measured over', async () => {
    // What the device does while a transcript streams in and the draft does not
    // change: the real input re-reports its own content height (24dp padding
    // included, 18.67dp per line on Android) on every content-size event, at
    // the same line count. None of those reports moves the pitch the cap snaps
    // to, so none may cost a render — the pre-change composer re-rendered
    // itself and its input on each one, and the input then reported again, the
    // nested-update cascade that ended in "Maximum update depth exceeded".
    const renderer = await mount();
    // The mirror lays the draft's six lines out first; the input then reports
    // its content height at the pitch it renders.
    layoutMirror(renderer, 6 * 20);
    reportNativeContentSize(24 + 6 * 18.667);
    expect(published.maxHeight).toBeCloseTo(24 + 5 * 18.667, 2);

    const reportRenders: number[] = [];
    for (let update = 1; update <= 30; update += 1) {
      // A touch of measurement drift, well under the stable step.
      reportRenders.push(reportNativeContentSize(24 + 6 * 18.667 + update * 0.01));
      // eslint-disable-next-line no-await-in-loop -- one report per stream update mirrors the device
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(reportRenders).toEqual(Array.from({ length: 30 }, () => 0));
    // The pitch the first report established still snaps the cap.
    expect(published.maxHeight).toBeCloseTo(24 + 5 * 18.667, 2);
    renderer.unmount();
  });

  it('records a report that follows a line growth, so the snapped cap survives the draft growing', async () => {
    // The report is divided by the line count the mirror currently shows, so a
    // report that follows a line growth must be recorded even though the pitch
    // it implies is unchanged: the height the earlier report left behind belongs
    // to the shorter draft, and dividing it by the taller count would decay the
    // estimated pitch and unsnap the cap as the draft grows.
    const renderer = await mount();
    layoutMirror(renderer, 6 * 20);
    reportNativeContentSize(24 + 6 * 18.667);
    expect(published.maxHeight).toBeCloseTo(24 + 5 * 18.667, 2);

    for (const lineCount of [7, 8, 9, 10]) {
      // The draft grows a line, the mirror lays that line out, and the real
      // input reports its content height for the same text at the pitch it
      // renders (18.67dp per line).
      layoutMirror(renderer, lineCount * 20);
      reportNativeContentSize(24 + lineCount * 18.667);
      // eslint-disable-next-line no-await-in-loop -- one report per rendered line mirrors the device
      await act(async () => {
        await Promise.resolve();
      });
    }

    // The pitch never moved, so the cap stays snapped to five native lines.
    expect(published.maxHeight).toBeCloseTo(24 + 5 * 18.667, 2);
    renderer.unmount();
  });

  it('still records a report that moves the pitch to another native line box', async () => {
    // The other half of the gate: a real pitch change (a different font, a
    // different platform's line box) at the same line count must still reach the
    // snap through the pitch clause, not the line-count one.
    const renderer = await mount();
    layoutMirror(renderer, 6 * 20);
    reportNativeContentSize(24 + 6 * 18.667);
    expect(published.maxHeight).toBeCloseTo(24 + 5 * 18.667, 2);

    const renders = reportNativeContentSize(24 + 6 * 22);
    expect(renders).toBeGreaterThan(0);
    expect(published.maxHeight).toBeCloseTo(24 + 4 * 22, 2);
    renderer.unmount();
  });
});
