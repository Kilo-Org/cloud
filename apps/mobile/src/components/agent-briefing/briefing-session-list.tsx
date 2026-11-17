import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { briefingSessionHref } from './briefing-session-href';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Bot } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { type BriefingReport } from '@/lib/agent-briefing';
import { useOrganization } from '@/lib/organization-context';

export function BriefingSessionList({ report }: Readonly<{ report: BriefingReport }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { setOrganizationId } = useOrganization();
  return (
    <Section label={t('agentBriefing.selectedSessions')}>
      <RowGroup leadingTile>
        {report.sessions.map(session => (
          <ConfigureRow
            key={session.sessionId}
            icon={Bot}
            title={session.title || t('agents.sessionRow.untitled')}
            onPress={() => {
              setOrganizationId(report.context.organizationId);
              router.push(briefingSessionHref(report, session.sessionId));
            }}
          />
        ))}
      </RowGroup>
    </Section>
  );
}
