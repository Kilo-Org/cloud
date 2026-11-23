import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Info } from '@/components/ui/icons';

/**
 * The body both transcript sheets show when the item they presented is no
 * longer in the session's live messages: the part detail sheet, whose part id
 * stops resolving, and the tool-run sheet, whose run has no live parts left.
 * Nothing can be re-read — the part is absent from the live messages, not a
 * failed request — so the state carries no action, and each sheet's header
 * Done is the way out of it. `placement="center"` because the state is the
 * whole sheet body: the shared state block then centres itself in the sheet
 * and owns the page gutter.
 */
export function VanishedPartState() {
  const { t } = useTranslation();
  return (
    <EmptyState
      placement="center"
      icon={Info}
      title={t('agentChat.partDetail.detailsUnavailable')}
      description={t('agentChat.partDetail.detailsUnavailableDescription')}
    />
  );
}
