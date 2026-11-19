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
 * The header is deliberately the close-only shape here and the cancel/commit
 * shape on the form. That split predates this component: the form carries a
 * commit action, and a state that cannot be submitted offers no Done to press.
 * Both shapes take their top clearance from the route's own formSheet inset.
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
