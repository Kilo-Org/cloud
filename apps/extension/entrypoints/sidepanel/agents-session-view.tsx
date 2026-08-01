/* eslint-disable max-lines -- Cohesive single view component; splitting would reduce clarity */
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import { useExtensionAgents } from './agents-provider';
import { AgentsMessageList } from './agents-message-list';
import { AgentsComposer } from './agents-composer';
import { AgentsBlockingCards } from './agents-blocking-cards';

const CREDITS_KEYWORDS =
  /(?:insufficient\s*credits|add\s*(?:at\s*least\s*)?\$\d|payment\s*required)/i;

const statusIndicatorClass = (type: string): string => {
  if (type === 'error') {
    return 'border-status-red-500/30 bg-status-red-500/10 text-status-red-400';
  }
  if (type === 'warning') {
    return 'border-status-yellow-500/30 bg-status-yellow-500/10 text-status-yellow-300';
  }
  return 'border-border bg-surface-selected text-foreground-muted';
};

// eslint-disable-next-line max-lines -- Single cohesive view component; splitting would reduce clarity
export const AgentsSessionView = ({
  kiloSessionId,
  onBack,
}: {
  kiloSessionId: string;
  onBack: () => void;
}): JSX.Element => {
  const { manager, organizationId } = useExtensionAgents();
  const { atoms } = manager;
  const messages = useAtomValue(atoms.messagesList);
  const isLoading = useAtomValue(atoms.isLoading);
  const isReadOnly = useAtomValue(atoms.isReadOnly);
  const canSend = useAtomValue(atoms.canSend);
  const canInterrupt = useAtomValue(atoms.canInterrupt);
  const isStreaming = useAtomValue(atoms.isStreaming);
  const statusIndicator = useAtomValue(atoms.statusIndicator);
  const error = useAtomValue(atoms.error);
  const failedPrompt = useAtomValue(atoms.failedPrompt);
  const activeQuestion = useAtomValue(atoms.activeQuestion);
  const activePermission = useAtomValue(atoms.activePermission);
  const fetchedSessionData = useAtomValue(atoms.fetchedSessionData);
  const sessionConfig = useAtomValue(atoms.sessionConfig);
  const hasOlderMessages = useAtomValue(atoms.hasOlderMessages);
  const isLoadingOlderMessages = useAtomValue(atoms.isLoadingOlderMessages);
  const olderMessagesError = useAtomValue(atoms.olderMessagesError);

  const [retryingPrompt, setRetryingPrompt] = useState(false);
  const [retryingSwitch, setRetryingSwitch] = useState(false);
  const [retrySucceeded, setRetrySucceeded] = useState(false);

  // When a new failedPrompt appears, reset the retry-succeeded flag.
  useEffect(() => {
    setRetrySucceeded(false);
  }, [failedPrompt]);

  // Single session lifecycle: clear error + switch on setup, destroy on cleanup.
  // On id change cleanup runs first (destroy old), then setup reconnects fresh.
  // Under StrictMode cleanup/re-setup cycles destroy + reconnect correctly —
  // No stale guard to skip the reconnect.
  useEffect(() => {
    manager.clearError();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded ID from untyped hook input
    void manager.switchSession(kiloSessionId as KiloSessionId);
    return () => {
      manager.destroy();
    };
  }, [kiloSessionId, manager]);

  const handleSend = useCallback(
    async (text: string) => {
      setRetrySucceeded(false);
      const rawMode = sessionConfig?.mode ?? '';
      const rawModel = sessionConfig?.model ?? '';
      const mode = rawMode === '' ? 'code' : rawMode;
      const model = rawModel === '' ? '' : rawModel;
      const variant = sessionConfig?.variant ?? undefined;
      try {
        const ok = await manager.send({
          payload: {
            mode,
            model,
            prompt: text,
            type: 'prompt',
            ...(variant === undefined ? {} : { variant }),
          },
        });
        if (ok) {
          setRetrySucceeded(true);
        }
      } catch {
        // Keep failedPrompt row visible — the SDK sets error atom, caller retains card.
      }
    },
    [manager, sessionConfig]
  );

  const handleStop = useCallback(() => {
    void manager.interrupt();
  }, [manager]);

  const handleRetryFailedPrompt = useCallback(async () => {
    if (failedPrompt === null) {
      return;
    }
    setRetryingPrompt(true);
    try {
      const variant = sessionConfig?.variant ?? undefined;
      const retryRawMode = sessionConfig?.mode ?? '';
      const retryRawModel = sessionConfig?.model ?? '';
      const ok = await manager.send({
        payload: {
          mode: retryRawMode === '' ? 'code' : retryRawMode,
          model: retryRawModel === '' ? '' : retryRawModel,
          prompt: failedPrompt,
          type: 'prompt',
          ...(variant === undefined ? {} : { variant }),
        },
      });
      if (ok) {
        setRetrySucceeded(true);
        manager.clearError();
      }
    } catch {
      // Keep failedPrompt row visible — the SDK sets error atom, caller retains card.
    } finally {
      setRetryingPrompt(false);
    }
  }, [failedPrompt, manager, sessionConfig]);

  const handleRetrySwitchSession = useCallback(() => {
    setRetryingSwitch(true);
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded ID from untyped hook input
        await manager.switchSession(kiloSessionId as KiloSessionId);
      } finally {
        setRetryingSwitch(false);
      }
    })();
  }, [kiloSessionId, manager]);

  const handleDismissError = useCallback(() => {
    manager.clearError();
  }, [manager]);

  const isCreditsError = error !== null && CREDITS_KEYWORDS.test(error);
  const isCreditsStatus =
    statusIndicator !== null &&
    statusIndicator.type === 'error' &&
    CREDITS_KEYWORDS.test(statusIndicator.message);

  const handleAnswerQuestion = useCallback(
    async (requestId: string, answers: string[][]) => {
      await manager.answerQuestion(requestId, answers);
    },
    [manager]
  );

  const handleRejectQuestion = useCallback(
    async (requestId: string) => {
      await manager.rejectQuestion(requestId);
    },
    [manager]
  );

  const handleRespondToPermission = useCallback(
    async (requestId: string, response: 'once' | 'always' | 'reject') => {
      await manager.respondToPermission(requestId, response);
    },
    [manager]
  );

  const handleLoadOlder = useCallback(() => {
    void manager.loadOlderMessages();
  }, [manager]);

  const rawTitle = fetchedSessionData?.title ?? '';
  const title = rawTitle === '' ? 'Session' : rawTitle;
  const repository = fetchedSessionData?.repository ?? fetchedSessionData?.gitUrl;
  const gitBranch = fetchedSessionData?.gitBranch;
  const hasRepoInfo = (repository ?? '') !== '' || (gitBranch ?? '') !== '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-2 py-2">
        <div className="flex items-center gap-2">
          <button
            aria-label="Back to sessions"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4 text-foreground" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate type-body font-medium text-foreground">{title}</h1>
            {hasRepoInfo ? (
              <p className="truncate type-label text-foreground-muted">
                {[repository, gitBranch].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Status indicator */}
      {statusIndicator === null ? null : (
        <div
          className={`shrink-0 border-b px-4 py-2 type-label ${statusIndicatorClass(statusIndicator.type)}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{statusIndicator.message}</span>
            {(() => {
              if (statusIndicator.type === 'error' && !isCreditsStatus) {
                return (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      className="type-label underline outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
                      onClick={handleDismissError}
                      type="button"
                    >
                      Dismiss
                    </button>
                    {failedPrompt === null || retrySucceeded ? (
                      <button
                        className="rounded-md border border-border bg-surface-overlay px-3 py-1 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
                        disabled={retryingSwitch}
                        onClick={handleRetrySwitchSession}
                        type="button"
                      >
                        {retryingSwitch ? 'Retrying…' : 'Retry'}
                      </button>
                    ) : null}
                  </div>
                );
              }
              if (isCreditsStatus) {
                return (
                  <a
                    className="shrink-0 rounded-md border border-border bg-surface-overlay px-3 py-1 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
                    href={
                      organizationId === null
                        ? `${getKiloApiBaseUrl()}/credits`
                        : `${getKiloApiBaseUrl()}/organizations/${encodeURIComponent(organizationId)}`
                    }
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Add credits
                  </a>
                );
              }
              return null;
            })()}
          </div>
        </div>
      )}

      {/* Error atom row */}
      {error === null ? null : (
        <div className="shrink-0 border-b border-status-red-500/30 bg-status-red-500/10 px-4 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-red-400" />
            <span className="min-w-0 flex-1 type-label text-status-red-400">{error}</span>
            {(() => {
              if (isCreditsError) {
                return (
                  <a
                    className="shrink-0 rounded-md border border-border bg-surface-overlay px-3 py-1 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
                    href={
                      organizationId === null
                        ? `${getKiloApiBaseUrl()}/credits`
                        : `${getKiloApiBaseUrl()}/organizations/${encodeURIComponent(organizationId)}`
                    }
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Add credits
                  </a>
                );
              }
              if (failedPrompt === null || retrySucceeded) {
                return (
                  <button
                    className="shrink-0 rounded-md border border-border bg-surface-overlay px-3 py-1 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
                    disabled={retryingSwitch}
                    onClick={handleRetrySwitchSession}
                    type="button"
                  >
                    {retryingSwitch ? 'Retrying…' : 'Retry'}
                  </button>
                );
              }
              return null;
            })()}
          </div>
        </div>
      )}

      {/* Failed prompt */}
      {failedPrompt !== null && !retrySucceeded && !isCreditsStatus && !isCreditsError ? (
        <div className="shrink-0 border-b border-status-red-500/30 bg-status-red-500/10 px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate type-label text-status-red-400">
              Message failed to send.
            </span>
            <button
              className="shrink-0 rounded-md border border-border bg-surface-overlay px-3 py-1 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
              disabled={retryingPrompt}
              onClick={() => {
                void handleRetryFailedPrompt();
              }}
              type="button"
            >
              {retryingPrompt ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Blocking cards */}
      <AgentsBlockingCards
        activePermission={activePermission}
        activeQuestion={activeQuestion}
        onAnswerQuestion={handleAnswerQuestion}
        onRejectQuestion={handleRejectQuestion}
        onRespondToPermission={handleRespondToPermission}
      />

      {/* Older messages loader */}
      {hasOlderMessages || olderMessagesError ? (
        <div className="shrink-0 border-b border-border px-4 py-2">
          {olderMessagesError ? (
            <div className="flex items-center justify-between gap-2">
              <span className="type-label text-foreground-muted">
                {olderMessagesError.kind === 'retryable'
                  ? 'Failed to load older messages'
                  : 'Could not load older messages'}
              </span>
              {olderMessagesError.kind === 'retryable' ? (
                <button
                  className="h-7 shrink-0 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
                  disabled={isLoadingOlderMessages}
                  onClick={handleLoadOlder}
                  type="button"
                >
                  {isLoadingOlderMessages ? 'Loading…' : 'Retry'}
                </button>
              ) : null}
            </div>
          ) : (
            <button
              className="h-8 w-full rounded-md border border-border bg-surface-overlay type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isLoadingOlderMessages}
              onClick={handleLoadOlder}
              type="button"
            >
              {isLoadingOlderMessages ? 'Loading…' : 'Load older messages'}
            </button>
          )}
        </div>
      ) : null}

      {/* Messages or skeleton */}
      {isLoading ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="agent-conversation-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="space-y-3">
              {[1, 2, 3, 4].map(idx => (
                <div className="flex justify-start" key={idx}>
                  <div className="max-w-[88%] space-y-1.5 rounded-lg px-3 py-2">
                    <span className="block h-3 w-48 animate-pulse rounded bg-surface-selected" />
                    <span className="block h-3 w-36 animate-pulse rounded bg-surface-selected" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <AgentsComposer
            canSend={false}
            canInterrupt={false}
            isStreaming={false}
            isLoading
            isReadOnly={false}
            onSend={() => {}}
            onStop={() => {}}
          />
        </div>
      ) : (
        <>
          <AgentsMessageList messages={messages} />
          <AgentsComposer
            canSend={canSend}
            canInterrupt={canInterrupt}
            isStreaming={isStreaming}
            isLoading={false}
            isReadOnly={isReadOnly}
            onSend={handleSend}
            onStop={handleStop}
          />
        </>
      )}
    </div>
  );
};
