import { useRouter } from 'expo-router';
import { MoreHorizontal } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath } from '@/lib/security-agent';

// Compatibility: external web report URL kept for the web client and app versions before the native report; remove when the minimum supported app version ships the native report.

/**
 * Header action that opens the native audit report — shared by the
 * dashboard, scope-entry, and settings-overview screens, all of which show
 * it only when the viewer can manage Security Agent for this scope.
 */
export function AuditReportButton({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <Pressable
      onPress={() => {
        router.push(getSecurityAgentPath(scope, 'audit-report'));
      }}
      accessibilityRole="button"
      accessibilityLabel={t('securityAgent.auditReportButton.viewA11y')}
      className="size-11 items-center justify-center active:opacity-70"
    >
      <MoreHorizontal size={20} color={colors.foreground} />
    </Pressable>
  );
}
