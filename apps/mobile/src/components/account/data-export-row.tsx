import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Archive } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';
import { i18n } from '@/i18n';

type DataExport = inferRouterOutputs<MobileRouter>['userExports']['list']['exports'][number];

const STATUS_KEYS = {
  queued: 'common.queued',
  processing: 'profile.dataExport.statusProcessing',
  finalizing: 'profile.dataExport.statusFinalizing',
  ready: 'profile.dataExport.statusReady',
  failed: 'common.failed',
  expired: 'profile.dataExport.statusExpired',
} as const satisfies Record<DataExport['status'], string>;

export function ExportRow({
  dataExport,
  requestingCode,
  onRequestCode,
}: Readonly<{
  dataExport: DataExport;
  requestingCode: boolean;
  onRequestCode: () => void;
}>) {
  const { t } = useTranslation();
  // Only a ready artifact has anything to fetch; the export worker owns every
  // other status and no retry here can move it along.
  const ready = dataExport.status === 'ready';

  return (
    <ConfigureRow
      icon={Archive}
      title={t('profile.dataExport.requestedOn', {
        date: formatDate(parseTimestamp(dataExport.requestedAt), i18n.language),
      })}
      subtitle={dataExport.failureMessage ?? i18n.t(STATUS_KEYS[dataExport.status])}
      subtitleNumberOfLines={2}
      trailing={
        ready ? (
          <Button
            variant="outline"
            size="sm"
            className={STATE_ACTION_CLASS}
            loading={requestingCode}
            disabled={requestingCode}
            accessibilityLabel={t('profile.dataExport.getCodeA11y')}
            onPress={onRequestCode}
          >
            <Text>{t('profile.dataExport.getCode')}</Text>
          </Button>
        ) : null
      }
    />
  );
}
