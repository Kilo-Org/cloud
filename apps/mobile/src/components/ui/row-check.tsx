import { Check, Square, SquareCheck } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { selectionCheckColor } from '@/lib/selection-check-color';

/**
 * The selection mark of a choice row. A single choice draws the check when the
 * row is selected and holds the same slot empty (a transparent stroke) when it
 * is not, so the label never reflows between states. A multiple choice draws a
 * box in both states, empty in the muted ink and checked in the selection ink:
 * with no mark on its unselected rows, a list the reader may pick several from
 * read as inert text. Its 18pt size is the row's contract (`apps/mobile/AGENTS.md`,
 * "Row anatomy"), so no caller pins its own.
 */
const ROW_CHECK_SIZE = 18;

type RowCheckProps = {
  selected: boolean;
  /** A disabled row dims the check to the muted ink instead of dimming its copy. */
  disabled?: boolean;
  /** The row is one of several the reader may select together. */
  multi?: boolean;
};

export function RowCheck({ selected, disabled = false, multi = false }: Readonly<RowCheckProps>) {
  const colors = useThemeColors();
  if (multi) {
    return selected ? (
      <SquareCheck size={ROW_CHECK_SIZE} color={selectionCheckColor(colors, disabled)} />
    ) : (
      <Square size={ROW_CHECK_SIZE} color={colors.mutedForeground} />
    );
  }
  return (
    <Check
      size={ROW_CHECK_SIZE}
      color={selected ? selectionCheckColor(colors, disabled) : 'transparent'}
    />
  );
}
