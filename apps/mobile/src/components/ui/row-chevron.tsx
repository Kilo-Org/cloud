import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The trailing disclosure mark: 14pt, muted, mirrored by the interface direction. */
const ROW_CHEVRON_SIZE = 14;

export function RowChevron() {
  const colors = useThemeColors();
  return <DirectionalChevronRight size={ROW_CHEVRON_SIZE} color={colors.mutedForeground} />;
}
