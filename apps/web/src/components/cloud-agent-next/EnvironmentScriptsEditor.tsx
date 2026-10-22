'use client';

import { useId, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { ENVIRONMENT_LIMITS } from '@kilocode/cloud-agent-profile';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function EnvironmentScriptsEditor({
  script,
  onChange,
}: {
  script: string;
  onChange: (script: string) => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <input
        ref={fileInput}
        type="file"
        accept=".sh,.bash,.txt,text/plain,application/x-sh"
        className="hidden"
        aria-label="Choose setup script file"
        onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setFileError(null);
          if (file.size > ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH * 4) {
            setFileError(
              `Scripts are limited to ${ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH} characters. Call a script in your repository for longer setup.`
            );
            return;
          }
          try {
            const text = await file.text();
            if (text.trim().length > ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH) {
              setFileError(
                `Scripts are limited to ${ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH} characters. Call a script in your repository for longer setup.`
              );
              return;
            }
            onChange(text);
          } catch {
            setFileError('Could not read the file. Paste the script instead.');
          }
        }}
      />
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={id}>Setup script</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="mr-2 size-3.5" />
            Choose file
          </Button>
        </div>
        <Textarea
          id={id}
          value={script}
          onChange={event => onChange(event.target.value)}
          rows={10}
          placeholder={'#!/bin/bash\npnpm install'}
          className="min-h-60 resize-y font-mono text-sm leading-6"
          spellCheck={false}
          autoCapitalize="none"
          aria-describedby={`${id}-help ${id}-count`}
          aria-invalid={script.trim().length > ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH}
        />
        <p
          id={`${id}-count`}
          className={cn(
            'text-right text-xs tabular-nums',
            script.trim().length > ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH
              ? 'text-destructive'
              : 'text-muted-foreground'
          )}
        >
          {script.trim().length} / {ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH}
        </p>
      </div>
      <p id={`${id}-help`} className="text-muted-foreground text-xs">
        Runs before the agent starts. For longer setup, call a script in your repository.
      </p>
      {fileError && (
        <p role="alert" className="text-destructive text-sm">
          {fileError}
        </p>
      )}
    </div>
  );
}
