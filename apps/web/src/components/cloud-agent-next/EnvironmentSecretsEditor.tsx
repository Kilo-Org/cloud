'use client';

import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { EnvironmentSecretDraft } from './environment-form';

type EnvironmentSecretsEditorProps = {
  secrets: EnvironmentSecretDraft[];
  onChange: (secrets: EnvironmentSecretDraft[]) => void;
};

export function EnvironmentSecretsEditor({ secrets, onChange }: EnvironmentSecretsEditorProps) {
  const [revealed, setRevealed] = useState<number | null>(null);

  const update = (index: number, patch: Partial<EnvironmentSecretDraft>) => {
    onChange(secrets.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const remove = (index: number) => onChange(secrets.filter((_, i) => i !== index));
  const add = () => onChange([...secrets, { key: '', value: '', existing: false, deleted: false }]);

  return (
    <div className="grid gap-2">
      <Label className="text-xs">Secrets</Label>
      {secrets.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          {row.existing ? (
            <code
              className={cn(
                'bg-muted w-44 shrink-0 truncate rounded px-2 py-1 font-mono text-xs',
                row.deleted && 'line-through opacity-60'
              )}
            >
              {row.key}
            </code>
          ) : (
            <Input
              value={row.key}
              onChange={event => update(index, { key: event.target.value })}
              placeholder="KEY"
              className="h-8 w-44 shrink-0 font-mono text-sm"
              autoComplete="off"
              data-1p-ignore="true"
              data-form-type="other"
            />
          )}

          {row.deleted ? (
            <>
              <span className="text-muted-foreground flex-1 text-xs">Will be deleted</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => update(index, { deleted: false })}
              >
                <Undo2 className="mr-1 h-3.5 w-3.5" />
                Undo
              </Button>
            </>
          ) : (
            <>
              <div className="relative flex-1">
                <Input
                  type={revealed === index ? 'text' : 'password'}
                  value={row.value}
                  onChange={event => update(index, { value: event.target.value })}
                  placeholder={row.existing ? 'Unchanged' : 'Secret value'}
                  className="h-8 pr-8 text-sm"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-form-type="other"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  onClick={() => setRevealed(revealed === index ? null : index)}
                >
                  {revealed === index ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0"
                title={row.existing ? `Delete ${row.key}` : 'Remove secret'}
                onClick={() => (row.existing ? update(index, { deleted: true }) : remove(index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      ))}
      <p className="text-muted-foreground text-xs">
        Secret values are encrypted and never shown again. Leave a value blank to keep the stored
        one.
      </p>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={add}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add secret
      </Button>
    </div>
  );
}
