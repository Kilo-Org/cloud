import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  APPLICABILITY_KEYS,
  describeMenu,
  FRAMEWORK_KEYS,
  type OpenMenu,
  RISK_CATEGORY_KEYS,
  SEVERITY_KEYS,
  withMenuChoice,
} from '@/components/organization/guardrails-rule-menu';
import { SettingsValueRow } from '@/components/organization/settings-form-sections';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { FormField } from '@/components/ui/form-field';
import { Trash2 } from '@/components/ui/icons';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { Text } from '@/components/ui/text';
import { selectionHaptic } from '@/lib/haptics';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { LINE_ACTION_BOX_CLASS } from '@/lib/a11y/tap-target';
import {
  GUARDRAILS_LIMITS,
  type OrgPolicyRule,
  RULE_FRAMEWORKS,
} from '@/lib/organization/guardrails-draft';
import { createPolicyRule } from '@/lib/organization/guardrails-issues';

/**
 * A key that follows one rule through the list's edits. Rule boxes hold
 * uncontrolled fields, so a box has to keep its own rule through a deletion; a
 * positional key would leave the deleted rule's text in the shifted rule's box.
 */
let nextRuleKey = 0;

function mintRuleKey(): string {
  nextRuleKey += 1;
  return `rule-${nextRuleKey}`;
}

/**
 * The policy violation detector's structured rules: one box per rule with its
 * id, name, text, category, applicability, severity, and the frameworks it
 * cites. Capped at `GUARDRAILS_LIMITS.rules`, the same cap the save applies.
 */
export function PolicyRulesEditor({
  rules,
  onChange,
  disabled,
}: Readonly<{
  rules: readonly OrgPolicyRule[];
  onChange: (next: OrgPolicyRule[]) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  // Reminted only when the array is replaced from outside the editor; the
  // editor's own add and remove keep every surviving rule's key.
  const [ruleKeys, setRuleKeys] = useState<readonly string[]>(() => rules.map(() => mintRuleKey()));
  if (ruleKeys.length !== rules.length) {
    setRuleKeys(rules.map(() => mintRuleKey()));
  }

  const updateRule = (index: number, patch: Partial<OrgPolicyRule>) => {
    onChange(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  };

  const menuRule = openMenu == null ? null : (rules[openMenu.index] ?? null);
  const menu = describeMenu(openMenu, menuRule, t);

  const selectMenuOption = (optionIndex: number) => {
    if (openMenu == null) {
      return;
    }
    const rule = rules[openMenu.index];
    if (rule === undefined) {
      return;
    }
    onChange(
      rules.map((current, at) =>
        at === openMenu.index ? withMenuChoice(current, openMenu, optionIndex) : current
      )
    );
    setOpenMenu(null);
  };

  return (
    <View className="gap-3">
      {rules.length === 0 ? (
        <Text className="text-xs text-muted-foreground">
          {t('organizationGuardrails.rulesEmpty')}
        </Text>
      ) : (
        rules.map((rule, index) => (
          <View key={ruleKeys[index] ?? index} className="gap-3 rounded-lg bg-background p-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-sm font-medium text-foreground">
                {t('organizationGuardrails.ruleNumber', { number: index + 1 })}
              </Text>
              <Pressable
                className={`${LINE_ACTION_BOX_CLASS} items-center justify-center active:opacity-70`}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('organizationGuardrails.ruleRemove', {
                  number: index + 1,
                })}
                onPress={() => {
                  setRuleKeys(keys => keys.filter((_key, at) => at !== index));
                  onChange(rules.filter((_rule, at) => at !== index));
                }}
              >
                <Trash2 size={16} color={colors.destructive} />
              </Pressable>
            </View>
            <FormField
              label={t('organizationGuardrails.ruleIdLabel')}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={GUARDRAILS_LIMITS.ruleIdLength}
              defaultValue={rule.id}
              disabled={disabled}
              onChangeText={value => {
                updateRule(index, { id: value });
              }}
            />
            <FormField
              label={t('organizationGuardrails.ruleNameLabel')}
              maxLength={GUARDRAILS_LIMITS.ruleDisplayTextLength}
              defaultValue={rule.display_text}
              disabled={disabled}
              onChangeText={value => {
                updateRule(index, { display_text: value });
              }}
            />
            <FormField
              label={t('organizationGuardrails.ruleTextLabel')}
              multiline
              numberOfLines={2}
              maxLength={GUARDRAILS_LIMITS.ruleTextLength}
              defaultValue={rule.text}
              disabled={disabled}
              onChangeText={value => {
                updateRule(index, { text: value });
              }}
            />
            <SettingsValueRow
              label={t('organizationGuardrails.ruleRiskCategory')}
              value={t(RISK_CATEGORY_KEYS[rule.risk_category])}
              disabled={disabled}
              onPress={() => {
                setOpenMenu({ index, field: 'riskCategory' });
              }}
            />
            <SettingsValueRow
              label={t('organizationGuardrails.ruleApplicability')}
              value={t(APPLICABILITY_KEYS[rule.applicability])}
              disabled={disabled}
              onPress={() => {
                setOpenMenu({ index, field: 'applicability' });
              }}
            />
            <SettingsValueRow
              label={t('securityAgent.filter.severity')}
              value={t(SEVERITY_KEYS[rule.severity])}
              disabled={disabled}
              onPress={() => {
                setOpenMenu({ index, field: 'severity' });
              }}
            />
            <View className="gap-1.5">
              <Text className="text-sm font-medium text-foreground">
                {t('organizationGuardrails.ruleFrameworks')}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {RULE_FRAMEWORKS.map(framework => {
                  const selected = rule.frameworks.includes(framework);
                  return (
                    <FilterChip
                      key={framework}
                      label={t(FRAMEWORK_KEYS[framework])}
                      selected={selected}
                      disabled={disabled}
                      onPress={() => {
                        selectionHaptic();
                        updateRule(index, {
                          frameworks: selected
                            ? rule.frameworks.filter(value => value !== framework)
                            : [...rule.frameworks, framework],
                        });
                      }}
                    />
                  );
                })}
              </View>
            </View>
          </View>
        ))
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled || rules.length >= GUARDRAILS_LIMITS.rules}
        onPress={() => {
          setRuleKeys(keys => [...keys, mintRuleKey()]);
          onChange([...rules, createPolicyRule(rules)]);
        }}
      >
        <Text>{t('organizationGuardrails.addRule')}</Text>
      </Button>
      <MenuSheet
        visible={openMenu != null}
        title={menu.title}
        options={menu.options}
        cancelLabel={t('common.cancel')}
        onSelect={selectMenuOption}
        onClose={() => {
          setOpenMenu(null);
        }}
      />
    </View>
  );
}
