/**
 * The Cloud Agent triggers list: the caller's own triggers, or an
 * organization's when the route names one.
 *
 * Every row is one trigger: what it is called, what fires it, the URL an
 * inbound call posts to, and the switch that pauses it. Opening a row is the
 * way into its configuration and its deliveries.
 */

import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Copy, Plus, Workflow } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { copyWebhookUrl } from '@/lib/cloud-triggers/copy-webhook-url';
import { useCloudTriggers, useTriggerMutations } from '@/lib/cloud-triggers/use-cloud-triggers';
import { type CloudTriggerListRow } from '@/lib/cloud-triggers/trigger-draft';
import { triggerCreateHref, triggerDetailHref } from '@/lib/cloud-triggers/trigger-routes';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

const SKELETON_ROWS = [0, 1];

/** The height two rows occupy, held by every state so the New action never moves. */
const BODY_BAND_CLASS = 'min-h-[220px]';

type TriggersListScreenProps = Readonly<{
  /** Organization scope from the route; absent is the caller's own triggers. */
  organizationId?: string;
}>;

function TriggerRow({
  trigger,
  busy,
  onOpen,
  onToggle,
}: Readonly<{
  trigger: CloudTriggerListRow;
  busy: boolean;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const activation =
    trigger.activationMode === 'scheduled'
      ? t('common.scheduled')
      : t('cloudAgent.triggers.activationWebhook');
  const details =
    trigger.githubRepo === null ? activation : `${trigger.githubRepo} · ${activation}`;
  // A scheduled trigger has no inbound URL, and a row this viewer may not write
  // (another member's run-as-creator trigger, or a role outside the write
  // roles) keeps its saved state but not a control the server would refuse.
  const showsInboundUrl = trigger.activationMode === 'webhook';
  const canToggle = trigger.canEdit === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={trigger.triggerId}
      onPress={onOpen}
      className="gap-2 rounded-lg bg-secondary p-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {trigger.triggerId}
        </Text>
        <Switch
          accessibilityLabel={t('cloudAgent.triggers.activeTitle')}
          value={trigger.isActive}
          onValueChange={onToggle}
          disabled={busy || !canToggle}
        />
      </View>
      <Text variant="muted" className="text-xs" numberOfLines={1}>
        {details}
      </Text>
      {showsInboundUrl ? (
        <View className="flex-row items-center gap-2">
          <Text variant="mono" className="min-w-0 flex-1 text-xs" numberOfLines={1}>
            {trigger.inboundUrl}
          </Text>
          <IconButton
            accessibilityLabel={t('common.copyLink')}
            onPress={() => {
              void copyWebhookUrl(trigger.inboundUrl);
            }}
            className="-my-2"
          >
            <Copy size={16} color={colors.mutedForeground} />
          </IconButton>
        </View>
      ) : null}
    </Pressable>
  );
}

export function TriggersListScreen({ organizationId }: TriggersListScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const boundary = useOrgBoundary(organizationId);
  const isOrgScope = organizationId !== undefined;
  // A push or a deep link can name an organization the viewer is not a member
  // of: the boundary owns that case, so the list read never fires until the
  // membership is confirmed.
  const scopeResolved = !isOrgScope || (!boundary.isResolving && boundary.org != null);
  useRouteForegroundRefresh([[['webhookTriggers']]]);
  const list = useCloudTriggers(organizationId, scopeResolved);
  const { setActive } = useTriggerMutations(null, organizationId);

  if (!scopeResolved) {
    return (
      <OrganizationBoundary
        title={t('cloudAgent.triggers.title')}
        organizationIdOverride={organizationId}
      />
    );
  }

  let body: ReactNode = null;
  if (list.isPending) {
    body = (
      <View className="gap-3">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[104px] rounded-lg" />
        ))}
      </View>
    );
  } else if (list.isError) {
    body = (
      <QueryError
        placement="top"
        variant="server"
        title={t('cloudAgent.triggers.loadFailedTitle')}
        message={t('cloudAgent.triggers.loadFailedDescription')}
        onRetry={() => void list.refetch()}
        isRetrying={list.isFetching}
      />
    );
  } else if (list.data.length === 0) {
    body = (
      <EmptyState
        placement="top"
        icon={Workflow}
        title={t('cloudAgent.triggers.emptyTitle')}
        description={t('cloudAgent.triggers.emptyDescription')}
      />
    );
  } else {
    body = (
      <View className="gap-3">
        {list.data.map(trigger => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            busy={setActive.isPending && setActive.variables.triggerId === trigger.triggerId}
            onOpen={() => {
              router.push(triggerDetailHref(trigger.triggerId, organizationId) as Href);
            }}
            onToggle={isActive => {
              setActive.mutate({
                triggerId: trigger.triggerId,
                isActive,
                ...(organizationId === undefined ? {} : { organizationId }),
              });
            }}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('cloudAgent.triggers.title')}
        headerRight={
          <IconButton
            accessibilityLabel={t('cloudAgent.triggers.new')}
            onPress={() => {
              router.push(triggerCreateHref(organizationId) as Href);
            }}
          >
            <Plus size={20} color={colors.foreground} />
          </IconButton>
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted" className="text-xs">
          {t('cloudAgent.triggers.subtitle')}
        </Text>
        <View className={BODY_BAND_CLASS} testID="triggers-list-body">{body}</View>
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => {
            router.push(triggerCreateHref(organizationId) as Href);
          }}
        >
          <Plus size={16} color={colors.foreground} />
          <Text>{t('cloudAgent.triggers.new')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
