import { type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SheetHeader } from '@/components/sheet-header';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';

/**
 * The chrome the dismiss sheet's form-less states share: the sheet's title and
 * its close button, over one of the body states the screen picks.
 *
 * A sheet state that is not the form must keep this same header: the sheet is
 * a formSheet route, so its edge owns the top clearance, and a second header
 * shape would move the title between states.
 */
export function DismissSheetFrame({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const headerTopInset = useFormSheetHeaderTopInset();
  return (
    <View className="flex-1 bg-background">
      <SheetHeader
        title={t('securityAgent.dismiss.title')}
        variant="close"
        topInset={headerTopInset}
        onDone={() => {
          router.back();
        }}
      />
      {children}
    </View>
  );
}
