import { type GlanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { AlertCircle, Circle } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionStatusIconProps = {
  kind: GlanceableStatusKind;
};

/**
 * The session's state as one glyph, the same three the Live Activity and the
 * widgets draw: an exclamation circle for a wait, a filled disc for work
 * in progress, a hollow ring for a connected agent doing nothing. The shapes
 * differ as well as the colors, so the state reads without color.
 *
 * Sized to the 12px platform glyph that shares the eyebrow cluster on
 * stored rows — the eyebrow decision never pairs the two on a live row —
 * so either mark alone keeps the cluster's optical weight.
 */
export function SessionStatusIcon({ kind }: Readonly<SessionStatusIconProps>) {
  const colors = useThemeColors();

  if (kind === 'needsInput') {
    return <AlertCircle size={12} color={colors.warn} />;
  }
  if (kind === 'running') {
    return <Circle size={12} color={colors.good} fill={colors.good} />;
  }
  return <Circle size={12} color={colors.mutedSoft} />;
}
