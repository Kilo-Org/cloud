import { useTranslation } from 'react-i18next';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { Plus } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionListFabProps = {
  organizationId: string | null;
  /** The frame that clears the fixed tab bar and the landscape sensor housing. */
  style: StyleProp<ViewStyle>;
};

/**
 * The Agents list's floating "New session" action. It is an absolutely
 * positioned overlay, so the screen owns its frame and this owns the control.
 */
export function SessionListFab({ organizationId, style }: SessionListFabProps) {
  const { openNewSession } = useNewSessionNavigator();
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.newSession')}
      testID="agents-new-session-fab"
      onPress={() => {
        openNewSession(organizationId);
      }}
      className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-[#00000040] active:opacity-80"
      style={style}
    >
      <Plus size={24} color={colors.primaryForeground} />
    </Pressable>
  );
}
