'use client';

import { useState, useCallback } from 'react';
import { Copy, Check, Terminal, ChevronUp, Cloud, Loader2 } from 'lucide-react';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { Button } from '@/components/ui/button';
import { useCloudSessionFork } from './use-cloud-session-fork';

type SessionContinuationPanelProps = {
  sessionId: string;
  /** Organization context the panel renders in; omitted for personal sessions. */
  organizationId?: string;
  /** Whether the source session is a Cloud Agent session that can be forked. */
  canForkToCloud?: boolean;
};

function SessionContinuationPanel({
  sessionId,
  organizationId,
  canForkToCloud = true,
}: SessionContinuationPanelProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { forkSessionToNewCloudSession, forkingSessionId } = useCloudSessionFork(organizationId);

  const cliCommand = `kilo --session ${sessionId} --cloud-fork`;
  const isForking = forkingSessionId === sessionId;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(cliCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [cliCommand]);

  const handleForkToCloud = useCallback(async () => {
    const forked = await forkSessionToNewCloudSession(sessionId);
    if (forked) {
      setExpanded(false);
    }
  }, [forkSessionToNewCloudSession, sessionId]);

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
          {canForkToCloud && (
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2"
              disabled={isForking}
              onClick={() => void handleForkToCloud()}
            >
              {isForking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cloud className="h-4 w-4" />
              )}
              {isForking
                ? 'Starting a new Cloud Agent session...'
                : 'Continue in a new Cloud Agent session'}
            </Button>
          )}

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
        </div>
      )}
    </div>
  );
}

export { SessionContinuationPanel };
