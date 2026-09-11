import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { TourStepHero } from '@/components/first-run-tour/tour-step-hero';
import { Cloud, type LucideIcon, Monitor, Sparkles } from '@/components/ui/icons';
import { InlineCodeText } from '@/components/ui/inline-code-text';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The two paths the opening fork offers; each maps to its own tour leg. */
export type TourPath = 'cloud' | 'cli';

type PathCardProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  onPress: () => void;
};

/** One fork option: tinted icon, path name, and a one-line description. */
function PathCard({ icon: Icon, title, description, onPress }: Readonly<PathCardProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-4 rounded-xl border border-border bg-secondary p-4 active:opacity-70"
    >
      <View className="h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
        <Icon size={20} color={colors.primary} strokeWidth={1.75} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        <InlineCodeText variant="muted" className="mt-1">
          {description}
        </InlineCodeText>
      </View>
    </Pressable>
  );
}

/**
 * Opening step of the tour: asks where to run Kilo and offers the two paths.
 * Selecting one sends the person to that path's own leg; the other stays
 * reachable by replaying the tour from the Profile 'Tutorial' item.
 */
export function TourChooseStep({ onSelect }: Readonly<{ onSelect: (path: TourPath) => void }>) {
  const { t } = useTranslation();

  return (
    <View className="flex-1">
      <TourStepHero icon={Sparkles}>
        <Text variant="muted" className="px-4 text-center leading-6">
          {t('firstRunTour.chooseBody')}
        </Text>
      </TourStepHero>
      <View className="mt-8 gap-3">
        <PathCard
          icon={Cloud}
          title={t('agentChat.instancePicker.cloudAgent')}
          description={t('agentChat.instancePicker.cloudAgentDescription')}
          onPress={() => {
            onSelect('cloud');
          }}
        />
        <PathCard
          icon={Monitor}
          title={t('firstRunTour.computerOption')}
          description={t('firstRunTour.computerOptionDescription')}
          onPress={() => {
            onSelect('cli');
          }}
        />
      </View>
    </View>
  );
}
