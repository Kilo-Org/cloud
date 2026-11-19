import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { RefusalStatus } from '@/components/refusal-status';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { trialRefusalMessage } from '@/lib/trial-refusal-copy';
import { cn } from '@/lib/utils';

// Development-only visual fixture, opened through the development fixture link.
// Reproduces the low-balance alert sheet's form in the state a rejected save
// leaves for a lapsed organization plan: the sheet's own body layout, the
// refusal line that names the cause, and Save in its disabled style. Nothing
// saves from here — there is no form, no mutation and no router — so the
// fixture cannot write to the account that runs it.
//
// `canManageBilling` paints the other reader of the same refusal: the sentence
// that offers the step, plus the billing step itself. The fixture supplies the
// action explicitly, so the design gate captures both readers without an
// organization whose role it would have to switch.
const noop = (): void => undefined;

export function LowBalanceAlertRefusalFixture({
  canManageBilling = false,
}: Readonly<{ canManageBilling?: boolean }>) {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background" testID="low-balance-alert-refusal">
      <ScreenHeader title={t('organization.lowBalanceAlert.title')} />
      <TabScreenScrollView
        className="flex-1 bg-background"
        contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-8')}
      >
        <View testID="low-balance-alert-refusal-status">
          <RefusalStatus
            message={trialRefusalMessage(canManageBilling)}
            action={
              canManageBilling
                ? { label: t('organization.hub.manageBilling'), onPress: noop }
                : undefined
            }
            className="text-sm"
          />
        </View>

        <Button disabled>
          <Text className="text-primary-foreground">{t('common.save')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
