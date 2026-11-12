import { describe, expect, it, vi } from 'vitest';

import {
  expectHiddenPill,
  info,
  pillOf,
  propsOf,
  render,
} from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

describe('SessionContextMetrics nothing to report', () => {
  // A settled empty stored session reports no usage ever, and its sheet has no
  // permission settings: a dash value slot would read as a permanent
  // placeholder, so the pill hides while the row keeps its space.
  it('hides the pill for a settled session with no usage and no sheet', () => {
    expectHiddenPill(
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
        autoApproveAvailable: false,
        onNothingToReport: true,
      })
    );
  });

  it('stays live for a session with reported usage even when marked nothing-to-report', () => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: info(),
      totalCostMicrodollars: 150_000,
      hasMessages: false,
      autoApproveAvailable: false,
      onNothingToReport: true,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps the pill live while nothing-to-report is still pending', () => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
      autoApproveAvailable: true,
      loading: true,
      onNothingToReport: false,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });
});
