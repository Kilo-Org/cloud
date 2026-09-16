'use client';

import { useState, useCallback } from 'react';
import { Copy, Check, Terminal, ChevronUp } from 'lucide-react';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';

type SessionContinuationPanelProps = {
  sessionId: string;
};

function SessionContinuationPanel({ sessionId }: SessionContinuationPanelProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const cliCommand = `kilo --session ${sessionId} --cloud-fork`;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(cliCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [cliCommand]);

  return (
    <div className="border-border bg-muted/30 border-t">
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between px-[max(1rem,calc(50%_-_27rem))] py-2 text-xs transition-colors"
      >
        <span>Continue this session</span>
        <ChevronUp className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : 'rotate-180'}`} />
      </button>

      {expanded && (
        <div className="space-y-3 px-[max(1rem,calc(50%_-_27rem))] pb-4">
          <OpenInEditorButton sessionId={sessionId} pathOverride={`/s/${sessionId}`} />

          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Terminal className="h-3.5 w-3.5" />
              <span>Or use the CLI</span>
            </div>
            <div className="bg-background border-border flex items-center gap-2 rounded-md border px-3 py-2">
              <code className="text-foreground flex-1 font-mono text-xs">{cliCommand}</code>
              <button
                type="button"
                onClick={handleCopy}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Copy command"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <p className="text-muted-foreground text-xs italic">
            Continue in Cloud Agent coming soon
          </p>
        </div>
      )}
    </div>
  );
}

export { SessionContinuationPanel };
