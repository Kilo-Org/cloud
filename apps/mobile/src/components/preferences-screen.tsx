import { Brain, type LucideIcon, Smartphone } from 'lucide-react-native';
import { Switch, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Text } from '@/components/ui/text';
import { useKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type PreferenceRowProps = Readonly<{
  icon: LucideIcon;
  title: string;
  subtitle: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (next: boolean) => void;
}>;

/** Switch row shaped like the Notifications category row. */
function PreferenceRow({
  icon: Icon,
  title,
  subtitle,
  value,
  disabled,
  onValueChange,
}: PreferenceRowProps) {
  const colors = useThemeColors();
  return (
    <View
      className={`min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3 ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon size={18} color={colors.secondaryForeground} />
      <View className="flex-1">
        <Text className="text-sm font-medium">{title}</Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {subtitle}
        </Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityState={{ disabled }}
        onValueChange={onValueChange}
      />
    </View>
  );
}

export function PreferencesScreen() {
  const {
    defaultExpanded,
    hasLoaded: reasoningLoaded,
    setDefaultExpanded,
  } = useReasoningPreference();
  const {
    keepScreenOn,
    hasLoaded: keepScreenOnLoaded,
    setKeepScreenOn,
  } = useKeepScreenOnPreference();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Preferences" />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <PreferenceRow
          icon={Brain}
          title="Auto expand thinking"
          subtitle="Show the agent's thinking expanded when it finishes."
          value={defaultExpanded}
          disabled={!reasoningLoaded}
          onValueChange={setDefaultExpanded}
        />
        <PreferenceRow
          icon={Smartphone}
          title="Keep screen on while on session page"
          subtitle="Hold the screen awake while the session is working."
          value={keepScreenOn}
          disabled={!keepScreenOnLoaded}
          onValueChange={setKeepScreenOn}
        />
      </TabScreenScrollView>
    </View>
  );
}
