import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { sheetUnderHandlePaddingClass } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { X } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * A half-detent sheet's title bar: the title, and the close control that every
 * sheet whose body scrolls needs. `Sheet` cannot dismiss such a sheet on a
 * gesture (`dismissGestures={false}`), so the control is the only way out that
 * is visible to sighted and screen-reader users alike; Android Back and the
 * scrim keep working beside it.
 *
 * The title stays a header, and the close control keeps the shared 48dp icon
 * target the `icon` button size renders, labelled with the shared `common.close`
 * copy so every catalog announces it in the reader's language.
 *
 * Every sheet that uses it presents the native drag handle, whose own padding
 * already leaves the room above the row: the row takes the under-handle pair
 * instead of its own top padding, and its caller does not add a `pt-*` above it.
 */
export function SheetTitleRow({
  title,
  onClose,
}: Readonly<{ title: string; onClose: () => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View
      className={cn('min-h-11 flex-row items-center gap-x-2 px-5', sheetUnderHandlePaddingClass())}
    >
      <Text accessibilityRole="header" className="min-w-0 flex-1 text-base font-semibold">
        {title}
      </Text>
      <Button size="icon" variant="ghost" accessibilityLabel={t('common.close')} onPress={onClose}>
        <X size={20} color={colors.foreground} />
      </Button>
    </View>
  );
}
