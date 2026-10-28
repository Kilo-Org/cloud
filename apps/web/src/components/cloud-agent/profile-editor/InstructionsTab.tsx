/** Read-only instructions tab for the profile editor. */
'use client';

import { FileText } from 'lucide-react';
import type { ProfileInstruction } from '@/hooks/useCloudAgentProfiles';

type Props = {
  instructions: ProfileInstruction[];
};

export function InstructionsTab({ instructions }: Props) {
  if (instructions.length === 0) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground py-2 text-center text-sm">
          No instruction files yet. Import a local Kilo config to add them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {instructions.map(instruction => (
        <div key={instruction.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="text-muted-foreground h-4 w-4" />
            <code className="bg-muted rounded px-2 py-0.5 font-mono text-sm">
              {instruction.name}.md
            </code>
            {!instruction.enabled && (
              <span className="text-muted-foreground text-xs uppercase tracking-wide">
                Disabled
              </span>
            )}
            <span className="text-muted-foreground text-xs">
              {(instruction.content.length / 1024).toFixed(1)} KB
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Applied to every session that uses this profile as{' '}
            <code className="font-mono">.kilocode/rules/{instruction.name}.md</code>.
          </p>
          <pre className="bg-muted/30 mt-2 max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs break-words whitespace-pre-wrap">
            {instruction.content}
          </pre>
        </div>
      ))}
    </div>
  );
}
