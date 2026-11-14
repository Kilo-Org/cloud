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
import { Pressable } from 'react-native';
import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type IntegrationRow } from '@/lib/integrations/integration-rows';
import {
  canManageProvider,
  type IntegrationProvider,
  type IntegrationScope,
  providerLabelKey,
} from '@/lib/integrations/provider-catalog';
import { cn } from '@/lib/utils';

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
  const canConnect = canManageProvider({
    provider: row.provider,
    scope,
    role,
    action: 'connect',
    installed: row.installed,
  });
  const canDisconnect = canManageProvider({
    provider: row.provider,
    scope,
    role,
    action: 'disconnect',
  });
  let subtitle = t('common.connected');
  if (!row.installed) {
    subtitle = t('common.notConnected');
  } else if (row.accountLabel) {
    subtitle = t('integrations.connectedTo', { account: row.accountLabel });
  }
  const namedAction = (action: string) => [action, label].join(t('common.sentenceJoiner'));

  // The page behind "Manage on the web" is the same manager-only surface as
  // Disconnect, so it follows the disconnect roles; Connect follows the
  // connect flow's own rule, which for GitLab admits any member.
  let action: ReactNode = null;
  if (row.actionPending) {
    // The connections read that decides between Disconnect and the web page has
    // not landed, so the row holds the button's space instead of guessing.
    action = <Skeleton className="h-9 w-24 rounded-md" />;
  } else if (row.installed && row.webManaged) {
    action = canDisconnect ? (
      <Button
        size="sm"
        variant="outline"
        onPress={onManageOnWeb}
        accessibilityLabel={namedAction(t('common.manageOnWeb'))}
      >
        <Text>{t('common.manageOnWeb')}</Text>
      </Button>
    ) : null;
  } else if (row.installed) {
    action = canDisconnect ? (
      <Button
        size="sm"
        variant="outline"
        loading={disconnecting}
        onPress={onDisconnect}
        accessibilityLabel={namedAction(t('integrations.disconnect'))}
      >
        <Text>{t('integrations.disconnect')}</Text>
      </Button>
    ) : null;
  } else {
    action = canConnect ? (
      <Button
        size="sm"
        loading={connecting}
        onPress={onConnect}
        accessibilityLabel={namedAction(t('common.connect'))}
      >
        <Text>{t('common.connect')}</Text>
      </Button>
    ) : null;
  }

  // An uninstalled row's body starts the same Connect action as its trailing
  // button, for every provider: the row names the service and its state, and a
  // tap on it is a tap on the only thing the row offers. An installed row stays
  // inert — its one action is Disconnect or the web page, and a body tap must
  // never take a destructive action by accident — and a pending row has no
  // action to offer yet.
  //
  // The wrapper is not an accessibility element (`accessible={false}`, and on
  // Android `importantForAccessibility="no"` keeps the row out of the tree while
  // its children stay in it): the trailing Button is the row's single named
  // control and carries the busy state, so a second stop here would read the
  // same provider twice — once unnamed of an action.
  const rowStartsConnect = !row.installed && !row.actionPending && canConnect;
  const configuredRow = (
    <ConfigureRow
      icon={PROVIDER_ICONS[row.provider]}
      title={label}
      subtitle={subtitle}
      subtitleNumberOfLines={1}
      trailing={action}
      last={last}
    />
  );
  if (!rowStartsConnect) {
    return configuredRow;
  }
  return (
    <Pressable
      onPress={onConnect}
      // A second tap while the browser is on its way must not mint again.
      disabled={connecting}
      accessible={false}
      importantForAccessibility="no"
      className={cn('active:opacity-70', connecting && 'opacity-70')}
    >
      {configuredRow}
    </Pressable>
  );
}
