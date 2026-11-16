/**
 * One trigger's screen: its saved configuration, the form that changes it, and
 * the deliveries it has taken.
 *
 * A trigger that runs as another member of the organization can only be changed
 * by them, and the screen then shows the configuration it cannot edit with the
 * reason, which is the rule the server enforces rather than a guess from a role.
 */

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { KVRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type CloudTriggerDetail } from '@/lib/cloud-triggers/trigger-draft';
import { useCloudTrigger } from '@/lib/cloud-triggers/use-cloud-triggers';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { trpcErrorVariant } from '@/lib/trpc-error';

import { TriggerDeliveries } from './trigger-deliveries';
import { TriggerEditPanel } from './trigger-edit-panel';
import { TriggerUrlCard } from './trigger-url-card';

const SKELETON_ROWS = [0, 1, 2];

function TriggerDetailSkeleton() {
  return (
    <View className="gap-3">
      {SKELETON_ROWS.map(row => (
        <Skeleton key={row} className="h-12 rounded-lg" />
      ))}
    </View>
  );
}

/**
 * What a trigger is, for the viewer who cannot change it. Every value is the
 * saved one; nothing here is editable, so the rows carry no control.
 */
function ReadOnlyTrigger({ detail }: Readonly<{ detail: CloudTriggerDetail }>) {
  const { t } = useTranslation();
  return (
    <View>
      <KVRow label={t('common.repository')} value={detail.githubRepo ?? t('common.unknown')} />
      <KVRow
        label={t('cloudAgent.triggers.fieldActivation')}
        value={
          detail.activationMode === 'scheduled'
            ? t('common.scheduled')
            : t('cloudAgent.triggers.activationWebhook')
        }
      />
      <KVRow label={t('cloudAgent.triggers.fieldAgent')} value={detail.mode ?? t('common.unknown')} />
      <KVRow label={t('common.model')} value={detail.model ?? t('common.unknown')} last valueFace="text" />
    </View>
  );
}

export function TriggerDetailScreen({
  triggerId,
  organizationId,
}: Readonly<{ triggerId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const boundary = useOrgBoundary(organizationId);
  const isOrgScope = organizationId !== undefined;
  const scopeResolved = !isOrgScope || (!boundary.isResolving && boundary.org != null);
  const query = useCloudTrigger(triggerId, organizationId, scopeResolved);

  if (!scopeResolved) {
    return (
      <OrganizationBoundary
        title={t('cloudAgent.triggers.title')}
        organizationIdOverride={organizationId}
      />
    );
  }

  let body: ReactNode;
  if (query.isPending) {
    body = <TriggerDetailSkeleton />;
  } else if (query.isError && query.data == null) {
    const variant = trpcErrorVariant(query.error);
    body =
      variant === 'not-found' ? (
        <QueryError
          placement="top"
          variant="not-found"
          title={t('cloudAgent.triggers.detailNotFoundTitle')}
          message={triggerId}
        />
      ) : (
        <QueryError
          placement="top"
          variant="server"
          title={t('cloudAgent.triggers.detailLoadFailedTitle')}
          message={t('cloudAgent.triggers.loadFailedDescription')}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      );
  } else if (query.data.canEdit) {
    body = <TriggerEditPanel detail={query.data} organizationId={organizationId} />;
  } else {
    body = (
      <View className="gap-4">
        <Text className="text-xs text-destructive">
          {query.data.canEditReason === 'creator_run'
            ? t('cloudAgent.triggers.cannotEditCreator')
            : t('cloudAgent.triggers.permissionDenied')}
        </Text>
        {query.data.activationMode === 'scheduled' ? null : (
          <TriggerUrlCard url={query.data.inboundUrl} />
        )}
        <ReadOnlyTrigger detail={query.data} />
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">
            {t('cloudAgent.triggers.deliveries')}
          </Text>
          <TriggerDeliveries triggerId={query.data.triggerId} organizationId={organizationId} />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={triggerId} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </TabScreenScrollView>
    </View>
  );
}
