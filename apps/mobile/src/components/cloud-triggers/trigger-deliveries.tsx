/**
 * What has arrived at a trigger: the inbound webhook calls and the scheduled
 * runs the worker captured, newest first.
 *
 * Each row names its own outcome rather than a colour, and a row whose run
 * produced a session offers that session, so an inbox of deliveries is also the
 * way into the runs they started.
 */

import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Workflow } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type CloudTriggerDelivery } from '@/lib/cloud-triggers/trigger-draft';
import { useTriggerDeliveries } from '@/lib/cloud-triggers/use-cloud-triggers';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

const STATUS_KEYS = {
  captured: 'cloudAgent.triggers.statusArrived',
  inprogress: 'common.running',
  success: 'common.completed',
  failed: 'common.failed',
} satisfies Record<CloudTriggerDelivery['processStatus'], string>;

const STATUS_TONE = {
  captured: 'text-muted-foreground',
  inprogress: 'text-muted-foreground',
  success: 'text-foreground',
  failed: 'text-destructive',
} satisfies Record<CloudTriggerDelivery['processStatus'], string>;

const SKELETON_ROWS = [0, 1, 2];

function DeliveryRow({ delivery }: Readonly<{ delivery: CloudTriggerDelivery }>) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const at = parseTimestamp(delivery.timestamp);
  const hasTime = !Number.isNaN(at.getTime());
  return (
    <View className="gap-1 border-b-[0.5px] border-hair-soft py-2">
      <View className="flex-row items-center gap-2">
        <Text className={`text-sm font-medium ${STATUS_TONE[delivery.processStatus]}`}>
          {t(STATUS_KEYS[delivery.processStatus])}
        </Text>
        <Text variant="muted" className="min-w-0 flex-1 text-xs" numberOfLines={1}>
          {delivery.triggerSource === 'scheduled'
            ? t('common.scheduled')
            : t('cloudAgent.triggers.activationWebhook')}
          {hasTime
            ? ` · ${formatDate(at, i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}`
            : ''}
        </Text>
      </View>
      {delivery.errorMessage === null ? null : (
        <Text className="text-xs text-destructive" numberOfLines={2}>
          {delivery.errorMessage}
        </Text>
      )}
      {delivery.kiloSessionId === null ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="self-start px-0"
          onPress={() => {
            router.push(`/(app)/agent-chat/${delivery.kiloSessionId}` as Href);
          }}
        >
          <Text>{t('cloudAgent.triggers.openSession')}</Text>
        </Button>
      )}
    </View>
  );
}

export function TriggerDeliveries({
  triggerId,
  organizationId,
}: Readonly<{ triggerId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const query = useTriggerDeliveries(triggerId, organizationId, true);

  if (query.isPending) {
    return (
      <View className="gap-2">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-10 rounded-md" />
        ))}
      </View>
    );
  }
  if (query.isError) {
    return (
      <QueryError
        placement="top"
        variant="server"
        title={t('cloudAgent.triggers.deliveriesLoadFailedTitle')}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }
  if (query.data.length === 0) {
    return (
      <EmptyState
        placement="top"
        compact
        icon={Workflow}
        title={t('cloudAgent.triggers.deliveriesEmptyTitle')}
        description={t('cloudAgent.triggers.deliveriesEmptyDescription')}
      />
    );
  }
  return (
    <View>
      {query.data.map(delivery => (
        <DeliveryRow key={delivery.id} delivery={delivery} />
      ))}
    </View>
  );
}
