import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

type TrialOfferNoteProps = Readonly<{
  /** Whether the create procedure grants this creator a trial window. */
  offersTrial: boolean;
  /** Distinguishes the painted line and its reserve from another instance. */
  testIDPrefix: string;
}>;

/**
 * The organization trial offer line, with its height owned whether or not it is
 * stated. A hidden copy of the sentence lays the line out at the device width
 * and font scale, so a cold start that has not answered and an account the
 * create procedure grants nothing to reserve the same space and never move the
 * form. Only an explicit eligible answer paints it, and the hidden copy is not
 * read aloud.
 */
export function TrialOfferNote({ offersTrial, testIDPrefix }: TrialOfferNoteProps) {
  const { t } = useTranslation();
  return (
    <View>
      <View
        className="opacity-0"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={`${testIDPrefix}-reserve`}
      >
        <Text variant="caption">{t('organization.create.trialNote')}</Text>
      </View>
      {offersTrial ? (
        <View className="absolute inset-0 justify-center" testID={testIDPrefix}>
          <Text variant="caption">{t('organization.create.trialNote')}</Text>
        </View>
      ) : null}
    </View>
  );
}
