import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';

import { i18n } from '@/i18n';

export function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

export function getAgentChatSessionHref(scope: string, cliSessionId: string | null): Href | null {
  if (!cliSessionId) {
    return null;
  }
  const path = `/(app)/agent-chat/${cliSessionId}`;
  return (isPersonalSecurityScope(scope) ? path : `${path}?organizationId=${scope}`) as Href;
}

export function formatExploitable(isExploitable: boolean | 'unknown'): string {
  if (isExploitable === 'unknown') {
    return i18n.t('securityAgent.analysis.unknown');
  }
  return isExploitable ? i18n.t('securityAgent.analysis.yes') : i18n.t('securityAgent.analysis.no');
}
