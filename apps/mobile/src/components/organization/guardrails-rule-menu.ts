import { type TFunction } from 'i18next';

import { type MenuSheetOption } from '@/components/ui/menu-sheet';
import {
  type OrgPolicyRule,
  RULE_APPLICABILITIES,
  RULE_RISK_CATEGORIES,
  RULE_SEVERITIES,
  type RuleApplicability,
  type RuleFramework,
  type RuleRiskCategory,
  type RuleSeverity,
} from '@/lib/organization/guardrails-draft';

export const RISK_CATEGORY_KEYS = {
  security_fraud: 'organizationGuardrails.riskCategory.securityFraud',
  safety_harm: 'organizationGuardrails.riskCategory.safetyHarm',
  privacy_data_protection: 'organizationGuardrails.riskCategory.privacyDataProtection',
  brand_reputation_trust: 'organizationGuardrails.riskCategory.brandReputationTrust',
  bias_fairness_ethical: 'organizationGuardrails.riskCategory.biasFairnessEthical',
  legal_ip_liability: 'organizationGuardrails.riskCategory.legalIpLiability',
  product_misuse_abuse: 'organizationGuardrails.riskCategory.productMisuse',
  performance_reliability_quality: 'organizationGuardrails.riskCategory.performanceQuality',
} satisfies Record<RuleRiskCategory, string>;

export const APPLICABILITY_KEYS = {
  user: 'organizationGuardrails.applicability.user',
  user_assistant: 'organizationGuardrails.applicability.userAssistant',
} satisfies Record<RuleApplicability, string>;

/** The severity words the security agent's own severity filter already carries. */
export const SEVERITY_KEYS = {
  critical: 'common.critical',
  high: 'securityAgent.filter.severityHigh',
  medium: 'securityAgent.filter.severityMedium',
  low: 'securityAgent.filter.severityLow',
} satisfies Record<RuleSeverity, string>;

/** Registry names, so a catalog translates only what differs from the acronym. */
export const FRAMEWORK_KEYS = {
  hipaa: 'organizationGuardrails.framework.hipaa',
  finra: 'organizationGuardrails.framework.finra',
  gdpr: 'organizationGuardrails.framework.gdpr',
  ccpa: 'organizationGuardrails.framework.ccpa',
  owasp_llm_2025: 'organizationGuardrails.framework.owasp',
  nist_ai_rmf: 'organizationGuardrails.framework.nist',
  eu_ai_act: 'organizationGuardrails.framework.euAiAct',
  iso_42001: 'organizationGuardrails.framework.iso',
} satisfies Record<RuleFramework, string>;

type MenuField = 'riskCategory' | 'applicability' | 'severity';

export type OpenMenu = Readonly<{ index: number; field: MenuField }>;

type MenuDescription = Readonly<{ title: string; options: readonly MenuSheetOption[] }>;

const EMPTY_MENU: MenuDescription = { title: '', options: [] };

export function describeMenu(
  openMenu: OpenMenu | null,
  rule: OrgPolicyRule | null,
  t: TFunction
): MenuDescription {
  if (openMenu == null) {
    return EMPTY_MENU;
  }
  switch (openMenu.field) {
    case 'riskCategory': {
      return {
        title: t('organizationGuardrails.ruleRiskCategory'),
        options: RULE_RISK_CATEGORIES.map(value => ({
          label: t(RISK_CATEGORY_KEYS[value]),
          selected: rule?.risk_category === value,
        })),
      };
    }
    case 'applicability': {
      return {
        title: t('organizationGuardrails.ruleApplicability'),
        options: RULE_APPLICABILITIES.map(value => ({
          label: t(APPLICABILITY_KEYS[value]),
          selected: rule?.applicability === value,
        })),
      };
    }
    case 'severity': {
      return {
        title: t('securityAgent.filter.severity'),
        options: RULE_SEVERITIES.map(value => ({
          label: t(SEVERITY_KEYS[value]),
          selected: rule?.severity === value,
        })),
      };
    }
    default: {
      return EMPTY_MENU;
    }
  }
}

export function withMenuChoice(
  rule: OrgPolicyRule,
  openMenu: OpenMenu,
  optionIndex: number
): OrgPolicyRule {
  switch (openMenu.field) {
    case 'riskCategory': {
      const value = RULE_RISK_CATEGORIES[optionIndex];
      return value === undefined ? rule : { ...rule, risk_category: value };
    }
    case 'applicability': {
      const value = RULE_APPLICABILITIES[optionIndex];
      return value === undefined ? rule : { ...rule, applicability: value };
    }
    case 'severity': {
      const value = RULE_SEVERITIES[optionIndex];
      return value === undefined ? rule : { ...rule, severity: value };
    }
    default: {
      return rule;
    }
  }
}
