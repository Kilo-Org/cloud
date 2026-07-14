import { getSecurityAgentAuditUrl } from '@kilocode/app-shared/security-agent';
import { MoreHorizontal } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Header action that opens the web audit report directly — shared by the
 * dashboard, scope-entry, and settings-overview screens, all of which show
 * it only when the viewer can manage Security Agent for this scope.
 */
export function AuditReportButton({ scope }: Readonly<{ scope: string }>) {
  const colors = useThemeColors();

  return (
    <Pressable
      onPress={() => {
        void openExternalUrl(getSecurityAgentAuditUrl(WEB_BASE_URL, scope), {
          label: 'audit report',
        });
      }}
      accessibilityRole="button"
      accessibilityLabel="View audit report"
      className="size-11 items-center justify-center active:opacity-70"
    >
      <MoreHorizontal size={20} color={colors.foreground} />
    </Pressable>
  );
}
