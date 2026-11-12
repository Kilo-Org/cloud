import {
  Bot,
  CircleDot,
  GitBranch,
  GitCommit,
  GitMerge,
  type LucideIcon,
  MessageSquare,
} from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Text } from '@/components/ui/text';
import { type IntegrationRow } from '@/lib/integrations/integration-rows';
import {
  canManageProvider,
  type IntegrationProvider,
  type IntegrationScope,
  providerLabelKey,
} from '@/lib/integrations/provider-catalog';

/**
 * The app's icon set carries no brand glyphs, so each provider takes the
 * closest existing one: repository tools share the git family, and the chat and
 * tracker services take a message and an issue glyph.
 */
const PROVIDER_ICONS = {
  github: GitBranch,
  slack: MessageSquare,
  gitlab: GitMerge,
  discord: Bot,
  linear: CircleDot,
  bitbucket: GitCommit,
} satisfies Record<IntegrationProvider, LucideIcon>;

type IntegrationProviderRowProps = Readonly<{
  row: IntegrationRow;
  scope: IntegrationScope;
  /** The viewer's role in the organization; unused in the personal scope. */
  role: string | undefined;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onManageOnWeb: () => void;
  last?: boolean;
}>;

/**
 * One service in the hub: its connection state, the account it belongs to, and
 * the one action the viewer may take. The action is omitted rather than
 * disabled when the viewer's role cannot manage the organization's
 * connections, because the server would reject it.
 */
export function IntegrationProviderRow({
  row,
  scope,
  role,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
  onManageOnWeb,
  last,
}: IntegrationProviderRowProps) {
  const { t } = useTranslation();
  const label = t(providerLabelKey(row.provider));
  const canManage = canManageProvider(row.provider, scope, role);
  let subtitle = t('common.connected');
  if (!row.installed) {
    subtitle = t('common.notConnected');
  } else if (row.accountLabel) {
    subtitle = t('integrations.connectedTo', { account: row.accountLabel });
  }
  const namedAction = (action: string) => [action, label].join(t('common.sentenceJoiner'));

  // A member reads the connections but changes none of them, on the web either:
  // the page behind "Manage on the web" is the same manager-only control.
  let action: ReactNode = null;
  if (canManage) {
    if (row.installed && row.webManaged) {
      action = (
        <Button
          size="sm"
          variant="outline"
          onPress={onManageOnWeb}
          accessibilityLabel={namedAction(t('integrations.manageOnWeb'))}
        >
          <Text>{t('integrations.manageOnWeb')}</Text>
        </Button>
      );
    } else if (row.installed) {
      action = (
        <Button
          size="sm"
          variant="outline"
          loading={disconnecting}
          onPress={onDisconnect}
          accessibilityLabel={namedAction(t('integrations.disconnect'))}
        >
          <Text>{t('integrations.disconnect')}</Text>
        </Button>
      );
    } else {
      action = (
        <Button
          size="sm"
          loading={connecting}
          onPress={onConnect}
          accessibilityLabel={namedAction(t('common.connect'))}
        >
          <Text>{t('common.connect')}</Text>
        </Button>
      );
    }
  }

  return (
    <ConfigureRow
      icon={PROVIDER_ICONS[row.provider]}
      title={label}
      subtitle={subtitle}
      subtitleNumberOfLines={1}
      trailing={action}
      last={last}
    />
  );
}
