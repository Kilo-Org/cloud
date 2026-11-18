'use client';

import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  webhookBodySchema,
  WEBHOOK_BODY_SCHEMA_EXAMPLE,
  type WebhookBodySchema,
} from '@kilocode/worker-utils/webhook-body-validation';

type Props = {
  initialSchema?: WebhookBodySchema | null;
  disabled?: boolean;
  onChange: (schema: WebhookBodySchema | null, valid: boolean) => void;
};

const exampleText = JSON.stringify(WEBHOOK_BODY_SCHEMA_EXAMPLE, null, 2);

export function BodyValidationField({ initialSchema, disabled, onChange }: Props) {
  const [enabled, setEnabled] = useState(initialSchema != null);
  const [text, setText] = useState(
    initialSchema ? JSON.stringify(initialSchema, null, 2) : exampleText
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(initialSchema != null);
    setText(initialSchema ? JSON.stringify(initialSchema, null, 2) : exampleText);
    setError(null);
  }, [initialSchema]);

  function update(nextText: string, nextEnabled: boolean) {
    if (!nextEnabled) {
      setError(null);
      onChange(null, true);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(nextText);
    } catch {
      setError('Enter a valid JSON schema object.');
      onChange(null, false);
      return;
    }
    const result = webhookBodySchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      setError(`${issue?.path.join('.') || 'Schema'}: ${issue?.message || 'Invalid schema'}`);
      onChange(null, false);
      return;
    }
    setError(null);
    onChange(result.data, true);
  }

  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor="bodyValidationEnabled" className="flex min-h-11 items-center gap-2">
        <Checkbox
          id="bodyValidationEnabled"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={checked => {
            setEnabled(checked);
            update(text, checked);
          }}
        />
        Validate request body
      </Label>
      <p id="bodySchemaHelp" className="text-muted-foreground max-w-prose text-xs">
        Reject invalid JSON and payloads that do not match this schema before the agent runs.
      </p>
      {enabled && (
        <div className="space-y-2">
          <p className="text-muted-foreground max-w-prose text-xs">
            Use const for a fixed URL or enum for a short list. Supports types, nested properties
            and items, required fields, additionalProperties, number ranges, length limits, pattern,
            allOf, anyOf, oneOf and not. Patterns use standard regular expressions. References and
            other keywords are not supported.
          </p>
          <Label htmlFor="bodySchema">JSON Schema</Label>
          <Textarea
            id="bodySchema"
            value={text}
            rows={12}
            maxLength={32768}
            spellCheck={false}
            disabled={disabled}
            className="w-full min-w-0 font-mono text-xs"
            aria-describedby={error ? 'bodySchemaHelp bodySchemaError' : 'bodySchemaHelp'}
            aria-invalid={!!error}
            onChange={event => {
              setText(event.target.value);
              update(event.target.value, true);
            }}
          />
          {error && (
            <p id="bodySchemaError" role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
