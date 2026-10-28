'use client';

import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  ENKRYPT_DETECTOR_LIMITS,
  ENKRYPT_RULE_APPLICABILITIES,
  ENKRYPT_RULE_FRAMEWORKS,
  ENKRYPT_RULE_RISK_CATEGORIES,
  ENKRYPT_RULE_SEVERITIES,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  createPolicyRule,
  issueAt,
  type EnkryptGuardrailsIssues,
} from './enkrypt-guardrails-draft';
import { FieldMessages } from './FieldMessages';

const RISK_CATEGORY_LABELS: Record<(typeof ENKRYPT_RULE_RISK_CATEGORIES)[number], string> = {
  security_fraud: 'Security and fraud',
  safety_harm: 'Safety and harm',
  privacy_data_protection: 'Privacy and data protection',
  brand_reputation_trust: 'Brand and reputation',
  bias_fairness_ethical: 'Bias and fairness',
  legal_ip_liability: 'Legal and IP liability',
  product_misuse_abuse: 'Product misuse',
  performance_reliability_quality: 'Performance and quality',
};

const APPLICABILITY_LABELS: Record<(typeof ENKRYPT_RULE_APPLICABILITIES)[number], string> = {
  user: 'User input',
  user_assistant: 'User input and responses',
};

const SEVERITY_LABELS: Record<(typeof ENKRYPT_RULE_SEVERITIES)[number], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const FRAMEWORK_LABELS: Record<(typeof ENKRYPT_RULE_FRAMEWORKS)[number], string> = {
  hipaa: 'HIPAA',
  finra: 'FINRA',
  gdpr: 'GDPR',
  ccpa: 'CCPA',
  owasp_llm_2025: 'OWASP LLM Top 10 (2025)',
  nist_ai_rmf: 'NIST AI RMF',
  eu_ai_act: 'EU AI Act',
  iso_42001: 'ISO/IEC 42001',
};

const ISSUE_PATH = 'policy_violation.rules';

export function EnkryptPolicyRulesEditor({
  rules,
  issues,
  onChange,
}: {
  rules: EnkryptPolicyRule[];
  issues: EnkryptGuardrailsIssues;
  onChange: (rules: EnkryptPolicyRule[]) => void;
}) {
  const updateRule = (index: number, patch: Partial<EnkryptPolicyRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const canAddRule = rules.length < ENKRYPT_DETECTOR_LIMITS.rules;

  return (
    <div className="grid gap-3">
      {rules.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No rules yet. Each rule describes one thing members&apos; inputs must not contain or ask
          for.
        </p>
      ) : (
        <ol className="grid gap-3">
          {rules.map((rule, index) => (
            <PolicyRuleFields
              key={index}
              index={index}
              rule={rule}
              issues={issues}
              onChange={patch => updateRule(index, patch)}
              onRemove={() => onChange(rules.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      )}
      {rules.length === 0 && <FieldMessages error={issues.get(ISSUE_PATH)} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAddRule}
          onClick={() => onChange([...rules, createPolicyRule(rules)])}
        >
          <Plus />
          Add rule
        </Button>
        <span className="text-muted-foreground text-sm tabular-nums">
          {rules.length} of {ENKRYPT_DETECTOR_LIMITS.rules} rules
        </span>
      </div>
    </div>
  );
}

function PolicyRuleFields({
  index,
  rule,
  issues,
  onChange,
  onRemove,
}: {
  index: number;
  rule: EnkryptPolicyRule;
  issues: EnkryptGuardrailsIssues;
  onChange: (patch: Partial<EnkryptPolicyRule>) => void;
  onRemove: () => void;
}) {
  const fieldId = useId();
  const path = `${ISSUE_PATH}.${index}`;
  const idError = issueAt(issues, `${path}.id`);
  const nameError = issueAt(issues, `${path}.display_text`);
  const [textTouched, setTextTouched] = useState(false);
  const textError = textTouched ? issueAt(issues, `${path}.text`) : undefined;
  const toggleFramework = (framework: EnkryptPolicyRule['frameworks'][number], checked: boolean) =>
    onChange({
      frameworks: checked
        ? [...rule.frameworks, framework]
        : rule.frameworks.filter(selected => selected !== framework),
    });

  return (
    <li className="border-border grid gap-4 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Rule {index + 1}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove rule ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <Label htmlFor={`${fieldId}-id`}>Rule ID</Label>
          <Input
            id={`${fieldId}-id`}
            className="font-mono"
            value={rule.id}
            maxLength={ENKRYPT_DETECTOR_LIMITS.ruleIdLength}
            aria-invalid={idError ? true : undefined}
            aria-describedby={idError ? `${fieldId}-id-error` : undefined}
            onChange={event => onChange({ id: event.target.value })}
          />
          <FieldMessages errorId={`${fieldId}-id-error`} error={idError} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={`${fieldId}-name`}>Name (optional)</Label>
          <Input
            id={`${fieldId}-name`}
            value={rule.display_text}
            maxLength={ENKRYPT_DETECTOR_LIMITS.ruleDisplayTextLength}
            placeholder="No customer records"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${fieldId}-name-error` : undefined}
            onChange={event => onChange({ display_text: event.target.value })}
          />
          <FieldMessages errorId={`${fieldId}-name-error`} error={nameError} />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${fieldId}-text`}>Rule</Label>
        <Textarea
          id={`${fieldId}-text`}
          rows={2}
          value={rule.text}
          maxLength={ENKRYPT_DETECTOR_LIMITS.ruleTextLength}
          placeholder="User queries must not include customer account numbers or balances."
          aria-invalid={textError ? true : undefined}
          aria-describedby={textError ? `${fieldId}-text-error` : undefined}
          onBlur={() => setTextTouched(true)}
          onChange={event => onChange({ text: event.target.value })}
        />
        <FieldMessages errorId={`${fieldId}-text-error`} error={textError} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <EnumSelect
          id={`${fieldId}-risk`}
          label="Risk category"
          value={rule.risk_category}
          options={ENKRYPT_RULE_RISK_CATEGORIES}
          labels={RISK_CATEGORY_LABELS}
          onChange={risk_category => onChange({ risk_category })}
        />
        <EnumSelect
          id={`${fieldId}-applies`}
          label="Applies to"
          value={rule.applicability}
          options={ENKRYPT_RULE_APPLICABILITIES}
          labels={APPLICABILITY_LABELS}
          onChange={applicability => onChange({ applicability })}
        />
        <EnumSelect
          id={`${fieldId}-severity`}
          label="Severity"
          value={rule.severity}
          options={ENKRYPT_RULE_SEVERITIES}
          labels={SEVERITY_LABELS}
          onChange={severity => onChange({ severity })}
        />
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Compliance frameworks (optional)</legend>
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          {ENKRYPT_RULE_FRAMEWORKS.map(framework => (
            <div key={framework} className="flex items-center gap-2">
              <Checkbox
                id={`${fieldId}-${framework}`}
                checked={rule.frameworks.includes(framework)}
                onCheckedChange={checked => toggleFramework(framework, checked)}
              />
              <Label htmlFor={`${fieldId}-${framework}`} className="font-normal">
                {FRAMEWORK_LABELS[framework]}
              </Label>
            </div>
          ))}
        </div>
      </fieldset>
    </li>
  );
}

function EnumSelect<T extends string>({
  id,
  label,
  value,
  options,
  labels,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={selected => {
          const option = options.find(candidate => candidate === selected);
          if (option) onChange(option);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
