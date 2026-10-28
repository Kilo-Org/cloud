'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  ENKRYPT_DETECTOR_LIMITS,
  ENKRYPT_PII_ENTITIES,
  type EnkryptDetectorId,
  type EnkryptPiiEntity,
} from '@kilocode/db/schema-types';
import {
  ENKRYPT_BLOCK_DETECTOR_IDS,
  ENKRYPT_REVISE_DETECTOR_IDS,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  issueAt,
  parseLineList,
  type EnkryptGuardrailsIssues,
  type EnkryptInputDetectorsDraft,
} from './enkrypt-guardrails-draft';
import { EnkryptPolicyRulesEditor } from './EnkryptPolicyRulesEditor';
import { FieldMessages } from './FieldMessages';
import { RadioCardGroup } from './RadioCardGroup';

export type UpdateEnkryptDetector = <K extends EnkryptDetectorId>(
  id: K,
  patch: Partial<EnkryptInputDetectorsDraft[K]>
) => void;

type ReviseDetectorId = (typeof ENKRYPT_REVISE_DETECTOR_IDS)[number];

const DETECTOR_DETAILS: Record<EnkryptDetectorId, { label: string; description: string }> = {
  injection_attack: {
    label: 'Prompt injection',
    description: 'Detects attempts to override instructions or jailbreak the model.',
  },
  pii: {
    label: 'PII and secrets',
    description: 'Detects personal data, credentials, IP addresses, and URLs.',
  },
  keyword_detector: {
    label: 'Banned keywords',
    description: 'Detects inputs that contain any keyword you list.',
  },
  topic_detector: {
    label: 'Topics',
    description: 'Flags inputs about any topic you list.',
  },
  policy_violation: {
    label: 'Policy violation',
    description: 'Flags inputs that break your organization policy, written as text or rules.',
  },
  toxicity: {
    label: 'Toxicity',
    description: 'Detects toxic, insulting, threatening, or hateful language.',
  },
  nsfw: {
    label: 'NSFW',
    description: 'Detects sexual or otherwise not-safe-for-work content.',
  },
  bias: {
    label: 'Bias',
    description: 'Detects biased or discriminatory language.',
  },
  sponge_attack: {
    label: 'Sponge attack',
    description: 'Detects inputs crafted to waste model compute.',
  },
};

const PII_ENTITY_DETAILS: Record<EnkryptPiiEntity, { label: string; description: string }> = {
  pii: { label: 'Personal data', description: 'Names, email addresses, phone numbers.' },
  secrets: { label: 'Secrets', description: 'API keys, tokens, passwords.' },
  ip_address: { label: 'IP addresses', description: 'IPv4 and IPv6 addresses.' },
  url: { label: 'URLs', description: 'Web addresses.' },
};

const POLICY_FORMAT_OPTIONS = [
  {
    value: 'rules',
    label: 'Structured rules',
    description: 'One rule per requirement, with a category and severity. Recommended.',
  },
  {
    value: 'policy_text',
    label: 'Policy text',
    description: 'Paste an existing policy as plain text.',
  },
] as const;

type ReviseChoice = 'off' | 'log' | 'block';

const REVISE_CHOICES: { value: ReviseChoice; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'log', label: 'Log only' },
  { value: 'block', label: 'Block' },
];

export function EnkryptDetectorList({
  detectors,
  issues,
  onUpdate,
}: {
  detectors: EnkryptInputDetectorsDraft;
  issues: EnkryptGuardrailsIssues;
  onUpdate: UpdateEnkryptDetector;
}) {
  const options = (id: EnkryptDetectorId) => (
    <DetectorOptions id={id} detectors={detectors} issues={issues} onUpdate={onUpdate} />
  );

  return (
    <div className="grid gap-8">
      <DetectorSection
        title="Always block"
        description="When one of these detects something, the request is blocked before it reaches the model."
      >
        {ENKRYPT_BLOCK_DETECTOR_IDS.map(id => (
          <DetectorRow
            key={id}
            id={id}
            enabled={detectors[id].enabled}
            control={(labelId, descriptionId) => (
              <Switch
                checked={detectors[id].enabled}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                onCheckedChange={enabled => onUpdate(id, { enabled })}
              />
            )}
          >
            {options(id)}
          </DetectorRow>
        ))}
      </DetectorSection>

      <DetectorSection
        title="Block or log"
        description="Enkrypt flags these without blocking. Choose whether a detection blocks the request or is only logged, in which case the request still reaches the model."
      >
        {ENKRYPT_REVISE_DETECTOR_IDS.map(id => (
          <DetectorRow
            key={id}
            id={id}
            enabled={detectors[id].enabled}
            control={(labelId, descriptionId) => (
              <ReviseChoiceControl
                labelId={labelId}
                descriptionId={descriptionId}
                value={reviseChoice(detectors, id)}
                onChange={choice =>
                  onUpdate(
                    id,
                    choice === 'off' ? { enabled: false } : { enabled: true, action: choice }
                  )
                }
              />
            )}
          >
            {options(id)}
          </DetectorRow>
        ))}
      </DetectorSection>
    </div>
  );
}

function reviseChoice(detectors: EnkryptInputDetectorsDraft, id: ReviseDetectorId): ReviseChoice {
  const detector = detectors[id];
  return detector.enabled ? detector.action : 'off';
}

function DetectorSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <div className="grid gap-1">
        <h3 id={titleId} className="text-sm font-semibold">
          {title}
        </h3>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <ul className="divide-border divide-y rounded-md border px-4">{children}</ul>
    </section>
  );
}

function DetectorRow({
  id,
  enabled,
  control,
  children,
}: {
  id: EnkryptDetectorId;
  enabled: boolean;
  control: (labelId: string, descriptionId: string) => ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const details = DETECTOR_DETAILS[id];

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <span id={labelId} className="text-sm font-medium">
            {details.label}
          </span>
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {details.description}
          </p>
        </div>
        {control(labelId, descriptionId)}
      </div>
      {enabled && children}
    </li>
  );
}

function ReviseChoiceControl({
  labelId,
  descriptionId,
  value,
  onChange,
}: {
  labelId: string;
  descriptionId: string;
  value: ReviseChoice;
  onChange: (value: ReviseChoice) => void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      className="bg-muted/40 inline-flex shrink-0 rounded-md border p-0.5"
    >
      {REVISE_CHOICES.map(choice => (
        <label
          key={choice.value}
          className={cn(
            'text-muted-foreground cursor-pointer rounded px-3 py-1 text-sm transition-colors',
            'hover:text-foreground has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-xs',
            'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]'
          )}
        >
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
            className="sr-only"
          />
          {choice.label}
        </label>
      ))}
    </div>
  );
}

function DetectorOptions({
  id,
  detectors,
  issues,
  onUpdate,
}: {
  id: EnkryptDetectorId;
  detectors: EnkryptInputDetectorsDraft;
  issues: EnkryptGuardrailsIssues;
  onUpdate: UpdateEnkryptDetector;
}) {
  switch (id) {
    case 'pii':
      return (
        <OptionsPanel>
          <PiiEntitiesField
            entities={detectors.pii.entities}
            error={issueAt(issues, 'pii.entities')}
            onChange={entities => onUpdate(id, { entities })}
          />
        </OptionsPanel>
      );
    case 'keyword_detector':
      return (
        <OptionsPanel>
          <LineListField
            label="Keywords"
            noun="keyword"
            maxItems={ENKRYPT_DETECTOR_LIMITS.keywords}
            placeholder={'Project Phoenix\nAcme Corp'}
            value={detectors.keyword_detector.banned_keywords}
            error={issueAt(issues, 'keyword_detector.banned_keywords')}
            onChange={banned_keywords => onUpdate(id, { banned_keywords })}
          />
        </OptionsPanel>
      );
    case 'topic_detector':
      return (
        <OptionsPanel>
          <LineListField
            label="Topics"
            noun="topic"
            maxItems={ENKRYPT_DETECTOR_LIMITS.topics}
            placeholder={'weapons\nelections'}
            value={detectors.topic_detector.topic}
            error={issueAt(issues, 'topic_detector.topic')}
            onChange={topic => onUpdate(id, { topic })}
          />
        </OptionsPanel>
      );
    case 'policy_violation': {
      const detector = detectors.policy_violation;
      return (
        <OptionsPanel>
          <RadioCardGroup
            legend="Policy format"
            options={POLICY_FORMAT_OPTIONS}
            value={detector.format}
            onChange={format => onUpdate(id, { format })}
          />
          {detector.format === 'rules' ? (
            <EnkryptPolicyRulesEditor
              rules={detector.rules}
              issues={issues}
              onChange={rules => onUpdate(id, { rules })}
            />
          ) : (
            <PolicyTextField
              value={detector.policy_text}
              error={issueAt(issues, 'policy_violation.policy_text')}
              onChange={policy_text => onUpdate(id, { policy_text })}
            />
          )}
        </OptionsPanel>
      );
    }
    case 'injection_attack':
    case 'toxicity':
    case 'nsfw':
    case 'bias':
    case 'sponge_attack':
      return null;
  }
}

function OptionsPanel({ children }: { children: ReactNode }) {
  return <div className="bg-muted/40 grid gap-4 rounded-md p-3">{children}</div>;
}

function PiiEntitiesField({
  entities,
  error,
  onChange,
}: {
  entities: EnkryptPiiEntity[];
  error: string | undefined;
  onChange: (entities: EnkryptPiiEntity[]) => void;
}) {
  const fieldId = useId();
  const toggleEntity = (entity: EnkryptPiiEntity, checked: boolean) =>
    onChange(checked ? [...entities, entity] : entities.filter(selected => selected !== entity));

  return (
    <fieldset className="grid gap-3" aria-describedby={error ? `${fieldId}-error` : undefined}>
      <legend className="mb-3 text-sm font-medium">Data to detect</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {ENKRYPT_PII_ENTITIES.map(entity => (
          <div key={entity} className="flex items-start gap-3">
            <Checkbox
              id={`${fieldId}-${entity}`}
              className="mt-0.5"
              checked={entities.includes(entity)}
              aria-describedby={`${fieldId}-${entity}-description`}
              onCheckedChange={checked => toggleEntity(entity, checked)}
            />
            <div className="grid gap-1">
              <Label htmlFor={`${fieldId}-${entity}`}>{PII_ENTITY_DETAILS[entity].label}</Label>
              <p id={`${fieldId}-${entity}-description`} className="text-muted-foreground text-sm">
                {PII_ENTITY_DETAILS[entity].description}
              </p>
            </div>
          </div>
        ))}
      </div>
      <FieldMessages errorId={`${fieldId}-error`} error={error} />
    </fieldset>
  );
}

function LineListField({
  label,
  noun,
  maxItems,
  placeholder,
  value,
  error,
  onChange,
}: {
  label: string;
  noun: string;
  maxItems: number;
  placeholder: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const fieldId = useId();
  const [touched, setTouched] = useState(false);
  const visibleError = touched ? error : undefined;
  const count = parseLineList(value).length;

  return (
    <div className="grid gap-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <Textarea
        id={fieldId}
        rows={3}
        value={value}
        placeholder={placeholder}
        aria-invalid={visibleError ? true : undefined}
        aria-describedby={
          visibleError ? `${fieldId}-description ${fieldId}-error` : `${fieldId}-description`
        }
        onBlur={() => setTouched(true)}
        onChange={event => onChange(event.target.value)}
      />
      <FieldMessages
        description={`One ${noun} per line. ${count} of ${maxItems} used.`}
        descriptionId={`${fieldId}-description`}
        error={visibleError}
        errorId={`${fieldId}-error`}
      />
    </div>
  );
}

function PolicyTextField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const fieldId = useId();
  const [touched, setTouched] = useState(false);
  const visibleError = touched ? error : undefined;

  return (
    <div className="grid gap-2">
      <Label htmlFor={fieldId}>Policy text</Label>
      <Textarea
        id={fieldId}
        rows={6}
        value={value}
        maxLength={ENKRYPT_DETECTOR_LIMITS.policyTextLength}
        placeholder="Members must not ask for help with anything illegal or share customer data."
        aria-invalid={visibleError ? true : undefined}
        aria-describedby={
          visibleError ? `${fieldId}-description ${fieldId}-error` : `${fieldId}-description`
        }
        onBlur={() => setTouched(true)}
        onChange={event => onChange(event.target.value)}
      />
      <FieldMessages
        description={`${value.length.toLocaleString('en-US')} of ${ENKRYPT_DETECTOR_LIMITS.policyTextLength.toLocaleString('en-US')} characters.`}
        descriptionId={`${fieldId}-description`}
        error={visibleError}
        errorId={`${fieldId}-error`}
      />
    </div>
  );
}
