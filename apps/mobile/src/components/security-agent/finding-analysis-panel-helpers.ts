import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';

import { i18n } from '@/i18n';

// Literal keys, never a template: the catalog check scans the source for the
// keys a lookup passes on, and a computed key is invisible to it. A code the
// schema does not know yet falls back to its humanized raw form (underscores
// become spaces) instead of a catalog key.
const CONFIDENCE_LABEL_KEYS: Record<string, string> = Object.freeze({
  high: 'securityAgent.sla.high',
  medium: 'securityAgent.sla.medium',
  low: 'securityAgent.sla.low',
});

const ACTION_LABEL_KEYS: Record<string, string> = Object.freeze({
  dismiss: 'securityAgent.analysis.action.dismiss',
  analyze_codebase: 'securityAgent.analysis.action.analyzeCodebase',
  manual_review: 'securityAgent.analysis.action.manualReview',
  open_pr: 'securityAgent.analysis.action.openPr',
  monitor: 'securityAgent.analysis.action.monitor',
});

function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

export function formatConfidence(confidence: string): string {
  // Object.hasOwn: a bare index would return inherited members like
  // `constructor` for an unknown code instead of falling through to humanize.
  const key = Object.hasOwn(CONFIDENCE_LABEL_KEYS, confidence)
    ? CONFIDENCE_LABEL_KEYS[confidence]
    : undefined;
  return key === undefined ? humanize(confidence) : i18n.t(key);
}

export function formatSuggestedAction(action: string): string {
  const key = Object.hasOwn(ACTION_LABEL_KEYS, action) ? ACTION_LABEL_KEYS[action] : undefined;
  return key === undefined ? humanize(action) : i18n.t(key);
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
    return i18n.t('common.unknown');
  }
  return isExploitable ? i18n.t('securityAgent.analysis.yes') : i18n.t('securityAgent.analysis.no');
}
