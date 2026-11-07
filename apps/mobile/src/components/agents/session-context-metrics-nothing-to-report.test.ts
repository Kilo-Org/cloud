import { describe, expect, it, vi } from 'vitest';

import { expectHiddenReservedBox, info, render } from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

describe('SessionContextMetrics nothing to report', () => {
  // A settled empty stored session reports no usage ever, and its sheet has no
  // permission settings: the dash value slots would read as a permanent
  // placeholder, so the pill paints nothing while it keeps its reserved box.
  it('hides the reserved box for a settled session with no usage and no sheet', () => {
    expectHiddenReservedBox(
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
    expect(root.type).toBe('Pressable');
    const props = root.props as { className?: string; onPress?: () => void };
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps the reserved box live while nothing-to-report is still pending', () => {
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
    expect(root.type).toBe('Pressable');
    const props = root.props as { className?: string; onPress?: () => void };
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });
});
