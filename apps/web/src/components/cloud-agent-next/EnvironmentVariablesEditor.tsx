'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function EnvironmentVariablesEditor({
  text,
  onChange,
  removedKeys,
  error,
}: {
  text: string;
  onChange: (text: string) => void;
  removedKeys: readonly string[];
  error: string | null;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="sr-only">
        Environment variables
      </Label>
      <Textarea
        id={id}
        value={text}
        onChange={event => onChange(event.target.value)}
        placeholder={
          'NODE_ENV=production\nAPI_KEY="your value"\n\n# Quote multiline values\nCONFIG="first line\nsecond line"'
        }
        rows={12}
        className="min-h-72 resize-y font-mono text-sm leading-6"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore="true"
        data-form-type="other"
        aria-invalid={!!error}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
      />
      <p id={`${id}-help`} className="text-muted-foreground text-xs leading-5">
        New and replaced values are encrypted. Keep <code>&lt;unchanged&gt;</code> to retain a saved
        value. Delete its line to remove it.
      </p>
      {removedKeys.length > 0 && (
        <p role="status" className="text-status-warning text-xs">
          Will delete: {removedKeys.join(', ')}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
