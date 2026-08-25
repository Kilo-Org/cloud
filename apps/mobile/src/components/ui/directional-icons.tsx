import { type ComponentProps } from 'react';
import { I18nManager } from 'react-native';

import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight } from '@/components/ui/icons';

type IconProps = ComponentProps<typeof ChevronRight>;

/**
 * Direction-aware icon wrappers. In RTL the native direction mirrors the
 * chrome, so a "back" chevron points right, a "forward"/trailing-disclosure
 * chevron points left, and a trailing arrow points left. Callers that mean
 * back, forward, or trailing disclosure must use these instead of the raw
 * Lucide icons.
 */
export function DirectionalChevronLeft(props: IconProps) {
  const Icon = I18nManager.isRTL ? ChevronRight : ChevronLeft;
  return <Icon {...props} />;
}

export function DirectionalChevronRight(props: IconProps) {
  const Icon = I18nManager.isRTL ? ChevronLeft : ChevronRight;
  return <Icon {...props} />;
}

export function DirectionalArrowRight(props: IconProps) {
  const Icon = I18nManager.isRTL ? ArrowLeft : ArrowRight;
  return <Icon {...props} />;
}
