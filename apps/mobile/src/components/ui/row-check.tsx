import { Check } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { selectionCheckColor } from '@/lib/selection-check-color';

/**
 * The selection mark of a choice row: the check when the row is selected, and
 * the same slot held empty (a transparent stroke) when it is not, so the
 * label never reflows between states. Its 18pt size is the row's contract
 * (`apps/mobile/AGENTS.md`, "Row anatomy"), so no caller pins its own.
 */
const ROW_CHECK_SIZE = 18;

type RowCheckProps = {
  selected: boolean;
  /** A disabled row dims the check to the muted ink instead of dimming its copy. */
  disabled?: boolean;
};

export function RowCheck({ selected, disabled = false }: Readonly<RowCheckProps>) {
  const colors = useThemeColors();
  return (
    <Check
      size={ROW_CHECK_SIZE}
      color={selected ? selectionCheckColor(colors, disabled) : 'transparent'}
    />
  );
}
