import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { briefingSessionHref } from './briefing-session-href';
import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { useOrganization } from '@/lib/organization-context';

export function BriefingSessionList({ report }: Readonly<{ report: BriefingReport }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { setOrganizationId } = useOrganization();
  return (
    <View className="gap-2">
      <Text className="font-semibold">{t('agentBriefing.selectedSessions')}</Text>
      {report.sessions.map(session => (
        <Pressable
          key={session.sessionId}
          accessibilityRole="button"
          className="gap-1 rounded-xl border border-border bg-card p-4 active:opacity-70"
          onPress={() => {
            setOrganizationId(report.context.organizationId);
            router.push(briefingSessionHref(report, session.sessionId));
          }}
        >
          <Text>{session.title || t('agents.sessionRow.untitled')}</Text>
        </Pressable>
      ))}
    </View>
  );
}
