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

import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { renderRowTrailing, type RowTrailingSpec } from '@/components/ui/row-trailing';
import { Skeleton } from '@/components/ui/skeleton';
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
  /** Runs the read that names a connected row's connection again. */
  onRetryConnection: () => void;
  retryingConnection: boolean;
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
  onRetryConnection,
  retryingConnection,
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

  // The row's one action lives in its trailing cell: the contract allows one
  // primary action per screen, and a hub of four filled buttons read as four of
  // them. Connect is that cell's text action; a management action stays a
  // secondary button, because it is not the row's primary offer. An installed
  // row offers Disconnect or the web page and never a body tap — a destructive
  // action must not follow from a stray tap — and a pending row has no action to
  // offer yet.
  let action: RowTrailingSpec | undefined = undefined;
  if (row.actionPending) {
    // The connections read that decides between Disconnect and the web page has
    // not landed, so the row holds the button's space instead of guessing.
    action = { kind: 'node', node: <Skeleton className="h-9 w-24 rounded-md" /> };
  } else if (row.installed && row.webManaged) {
    action = canDisconnect
      ? {
          kind: 'node',
          node: (
            <Button
              size="sm"
              variant="outline"
              onPress={onManageOnWeb}
              accessibilityLabel={namedAction(t('common.manageOnWeb'))}
            >
              <Text>{t('common.manageOnWeb')}</Text>
            </Button>
          ),
        }
      : undefined;
  } else if (row.installed && row.canDisconnectNatively) {
    action = canDisconnect
      ? {
          kind: 'node',
          node: (
            <Button
              size="sm"
              variant="outline"
              loading={disconnecting}
              onPress={onDisconnect}
              accessibilityLabel={namedAction(t('integrations.disconnect'))}
            >
              <Text>{t('integrations.disconnect')}</Text>
            </Button>
          ),
        }
      : undefined;
  } else if (row.installed) {
    // An installed row is never inert: the app cannot name the connection it
    // would remove because the read that names it failed, so the row offers
    // that read again instead of a management action it cannot perform.
    action = canDisconnect
      ? {
          kind: 'node',
          node: (
            <Button
              size="sm"
              variant="outline"
              loading={retryingConnection}
              onPress={onRetryConnection}
              accessibilityLabel={namedAction(t('common.retry'))}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          ),
        }
      : undefined;
  } else if (canConnect) {
    // The browser hand-off is the one thing this row offers, and the cell is
    // its control: it keeps the action's name and its label while the browser
    // is on its way, refuses a second press, and announces the wait. Replacing
    // the control with a bare spinner dropped the name the tap had, so a
    // reader was told nothing while the row sat unanswerable.
    action = {
      kind: 'action',
      label: t('common.connect'),
      onPress: onConnect,
      disabled: connecting,
      accessibilityLabel: namedAction(t('common.connect')),
      accessibilityState: { disabled: connecting, busy: connecting },
    };
  }

  return (
    <ConfigureRow
      icon={PROVIDER_ICONS[row.provider]}
      title={label}
      subtitle={subtitle}
      subtitleNumberOfLines={1}
      trailing={renderRowTrailing(action)}
    />
  );
}
