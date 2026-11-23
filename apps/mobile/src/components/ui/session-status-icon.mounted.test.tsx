import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lightColors } from '@/lib/hooks/theme-colors.generated';

import { SessionStatusIcon } from './session-status-icon';

// The glyphs take the scheme's inks from the theme hook; the icon barrel is
// stubbed so the assertion reads the colour the component actually passes.
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Circle: 'Circle',
  Clock: 'Clock',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ ...lightColors, mutedSoft: 'MUTED-SOFT' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

/** The one glyph the kind draws, and the props the component gave it. */
function glyph(kind: Parameters<typeof SessionStatusIcon>[0]['kind']) {
  act(() => {
    renderer = TestRenderer.create(<SessionStatusIcon kind={kind} />);
  });
  const root = renderer?.root;
  if (!root) {
    throw new Error('Missing SessionStatusIcon renderer');
  }
  const drawn = (['Clock', 'Circle', 'AlertCircle'] as const).flatMap(type =>
    root.findAllByType(type)
  );
  expect(drawn).toHaveLength(1);
  return { type: drawn[0]?.type, props: drawn[0]?.props as { color: string; fill?: string } };
}

beforeEach(() => {
  renderer = undefined;
});
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});

describe('session status glyph ink', () => {
  // The idle ring and the scheduled clock are the mark's whole meaning, so they
  // must carry the muted text ink and not the focus-only soft tone, which
  // measured about 2.2–2.5:1 on the page, the card and the pill.
  it.each(['idle', 'scheduled'] as const)('paints the %s mark with the muted text ink', kind => {
    const { props } = glyph(kind);
    expect(props.color).toBe(lightColors.mutedForeground);
  });

  it('keeps the running disc filled and the needs-input circle in the warn ink', () => {
    expect(glyph('running').props).toMatchObject({
      color: lightColors.good,
      fill: lightColors.good,
    });
    expect(glyph('needsInput').props.color).toBe(lightColors.warn);
  });
});
