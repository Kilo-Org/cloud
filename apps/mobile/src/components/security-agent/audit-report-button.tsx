import { FileText } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath } from '@/lib/security-agent';

// Compatibility: external web report URL kept for the web client and app versions before the native report; remove when the minimum supported app version ships the native report.

/**
 * Header action that opens the native audit report — shared by the
 * dashboard, scope-entry, and settings-overview screens, all of which show
 * it only when the viewer can manage Security Agent for this scope.
 *
 * The glyph is a document, not the horizontal ellipsis: the press opens the
 * report directly and never a menu, so the icon has to name its destination
 * the way the accessibility label does (explorer finding: a `MoreHorizontal`
 * action that navigates straight to the report promised a menu it never shows).
 */
export function AuditReportButton({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <IconButton
      onPress={() => {
        pushOnce(getSecurityAgentPath(scope, 'audit-report'));
      }}
      accessibilityLabel={t('securityAgent.auditReportButton.viewA11y')}
    >
      <FileText size={20} color={colors.foreground} />
    </IconButton>
  );
}
