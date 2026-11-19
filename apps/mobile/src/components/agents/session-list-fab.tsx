import { useTranslation } from 'react-i18next';
import { type StyleProp, type ViewStyle } from 'react-native';

import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { Fab } from '@/components/ui/fab';

type SessionListFabProps = {
  organizationId: string | null;
  /** The frame that clears the fixed tab bar and the landscape sensor housing. */
  style: StyleProp<ViewStyle>;
};

/**
 * The Agents list's floating "New session" action: the shared `Fab` with the
 * composer route its press opens.
 */
export function SessionListFab({ organizationId, style }: SessionListFabProps) {
  const { openNewSession } = useNewSessionNavigator();
  const { t } = useTranslation();

  return (
    <Fab
      label={t('common.newSession')}
      testID="agents-new-session-fab"
      onPress={() => {
        openNewSession(organizationId);
      }}
      style={style}
    />
  );
}
