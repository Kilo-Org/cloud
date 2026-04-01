'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  createSessionManager,
  type SessionManager,
  type SessionSnapshot,
  type ResolvedSession,
  type FetchedSessionData,
  type KiloSessionId,
  type CloudAgentSessionId,
} from '@/lib/cloud-agent-sdk';
import { SESSION_INGEST_WS_URL } from '@/lib/constants';
import { usePostHog } from 'posthog-js/react';

const ManagerContext = createContext<SessionManager | null>(null);

type CloudAgentProviderProps = {
  children: ReactNode;
  organizationId?: string;
};

export function CloudAgentProvider({ children, organizationId }: CloudAgentProviderProps) {
  const storeRef = useRef(createStore());
  const trpcClient = useRawTRPCClient();
  const posthog = usePostHog();
  const posthogRef = useRef(posthog);
  posthogRef.current = posthog;

  // Create manager once per provider instance.
  // trpcClient is stable (from context); organizationId is stable per provider mount.
  const managerRef = useRef<SessionManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = createSessionManager({
      store: storeRef.current,

      resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
        try {
          const session = await trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
          if (session.cloud_agent_session_id) {
            return {
              kiloSessionId,
              cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId,
              isLive: true,
            };
          }
          // CLI session — check if live
          let isLive = false;
          try {
            const active = await trpcClient.activeSessions.list.query();
            isLive = active.sessions.some(s => s.id === kiloSessionId);
          } catch {
            /* not live */
          }
          return { kiloSessionId, cloudAgentSessionId: null, isLive };
        } catch {
          // Not found — treat as cloud agent session ID directly (backward compat)
          return {
            kiloSessionId,
            cloudAgentSessionId: kiloSessionId as unknown as CloudAgentSessionId,
            isLive: true,
          };
        }
      },

      getTicket: async (sessionId: CloudAgentSessionId): Promise<string> => {
        const body: Record<string, string> = { cloudAgentSessionId: sessionId };
        if (organizationId) body.organizationId = organizationId;
        const response = await fetch('/api/cloud-agent-next/sessions/stream-ticket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const errorData = (await response.json()) as { error?: string };
          throw new Error(errorData.error ?? 'Failed to get stream ticket');
        }
        const result = (await response.json()) as { ticket: string };
        return result.ticket;
      },

      fetchSnapshot: async (id: KiloSessionId) => {
        const [sessionData, messagesResult] = await Promise.all([
          trpcClient.cliSessionsV2.get.query({ session_id: id }),
          trpcClient.cliSessionsV2.getSessionMessages.query({ session_id: id }),
        ]);
        return {
          info: {
            id: sessionData.session_id,
            parentID: sessionData.parent_session_id ?? undefined,
          },
          // Zod .passthrough() adds index signatures that TS can't prove assignable to strict types.
          // The tRPC/Zod layer has already validated the shape, so this cast is safe at this boundary.
          messages: messagesResult.messages as SessionSnapshot['messages'],
        };
      },

      getAuthToken: async () => {
        const result = await trpcClient.activeSessions.getToken.query();
        return result.token;
      },

      cliWebsocketUrl: SESSION_INGEST_WS_URL ? `${SESSION_INGEST_WS_URL}/api/user/web` : undefined,

      api: {
        send: async payload => {
          const castSessionId = payload.sessionId as string;
          const prompt = payload.prompt as string;
          const mode = payload.mode as 'code' | 'plan' | 'debug' | 'orchestrator' | 'ask';
          const model = payload.model as string;
          const variant = payload.variant as string | undefined;
          if (organizationId) {
            return trpcClient.organizations.cloudAgentNext.sendMessage.mutate(
              {
                cloudAgentSessionId: castSessionId,
                prompt,
                mode,
                model,
                variant,
                autoCommit: true,
                organizationId,
              },
              { context: { skipBatch: true } }
            );
          }
          return trpcClient.cloudAgentNext.sendMessage.mutate(
            { cloudAgentSessionId: castSessionId, prompt, mode, model, variant, autoCommit: true },
            { context: { skipBatch: true } }
          );
        },

        interrupt: async payload => {
          if (organizationId) {
            return trpcClient.organizations.cloudAgentNext.interruptSession.mutate(
              { organizationId, sessionId: payload.sessionId },
              { context: { skipBatch: true } }
            );
          }
          return trpcClient.cloudAgentNext.interruptSession.mutate(
            { sessionId: payload.sessionId },
            { context: { skipBatch: true } }
          );
        },

        answer: async payload => {
          // Manager uses requestId; tRPC schema uses questionId
          if (organizationId) {
            return trpcClient.organizations.cloudAgentNext.answerQuestion.mutate(
              {
                organizationId,
                sessionId: payload.sessionId,
                questionId: payload.requestId,
                answers: payload.answers,
              },
              { context: { skipBatch: true } }
            );
          }
          return trpcClient.cloudAgentNext.answerQuestion.mutate(
            {
              sessionId: payload.sessionId,
              questionId: payload.requestId,
              answers: payload.answers,
            },
            { context: { skipBatch: true } }
          );
        },

        reject: async payload => {
          // Manager uses requestId; tRPC schema uses questionId
          if (organizationId) {
            return trpcClient.organizations.cloudAgentNext.rejectQuestion.mutate(
              { organizationId, sessionId: payload.sessionId, questionId: payload.requestId },
              { context: { skipBatch: true } }
            );
          }
          return trpcClient.cloudAgentNext.rejectQuestion.mutate(
            { sessionId: payload.sessionId, questionId: payload.requestId },
            { context: { skipBatch: true } }
          );
        },

        respondToPermission: async payload => {
          const trpc = organizationId
            ? trpcClient.organizations.cloudAgentNext
            : trpcClient.cloudAgentNext;
          await trpc.answerPermission.mutate(
            {
              ...(organizationId ? { organizationId } : {}),
              sessionId: payload.sessionId,
              permissionId: payload.requestId,
              response: payload.response,
            },
            { context: { skipBatch: true } }
          );
        },
      },

      prepare: async input => {
        // PrepareInput.mode is string; tRPC schema expects the specific union
        type AgentMode =
          | 'code'
          | 'plan'
          | 'debug'
          | 'orchestrator'
          | 'ask'
          | 'build'
          | 'architect'
          | 'custom';
        const castInput = { ...input, mode: input.mode as AgentMode };
        const result = organizationId
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
              ...castInput,
              organizationId,
            })
          : await trpcClient.cloudAgentNext.prepareSession.mutate(castInput);
        return {
          cloudAgentSessionId: result.cloudAgentSessionId as CloudAgentSessionId,
        };
      },

      initiate: async input => {
        if (organizationId) {
          return trpcClient.organizations.cloudAgentNext.initiateFromPreparedSession.mutate(
            { cloudAgentSessionId: input.cloudAgentSessionId, organizationId },
            { context: { skipBatch: true } }
          );
        }
        return trpcClient.cloudAgentNext.initiateFromPreparedSession.mutate(
          { cloudAgentSessionId: input.cloudAgentSessionId },
          { context: { skipBatch: true } }
        );
      },

      fetchSession: async (kiloSessionId: KiloSessionId): Promise<FetchedSessionData> => {
        const sessionResult = await trpcClient.cliSessionsV2.getWithRuntimeState.query({
          session_id: kiloSessionId,
        });
        const rs = sessionResult.runtimeState;

        return {
          kiloSessionId,
          cloudAgentSessionId: sessionResult.cloud_agent_session_id as CloudAgentSessionId | null,
          title: sessionResult.title,
          organizationId: sessionResult.organization_id,
          gitUrl: sessionResult.git_url,
          gitBranch: rs?.upstreamBranch ?? sessionResult.git_branch,
          mode: rs?.mode ?? null,
          model: rs?.model ?? null,
          variant: rs?.variant ?? null,
          repository: rs?.githubRepo ?? null,
          isInitiated: Boolean(rs?.initiatedAt),
          needsLegacyPrepare: Boolean(sessionResult.cloud_agent_session_id && !rs),
          isPreparingAsync: Boolean(rs && !rs.preparedAt),
        };
      },

      onKiloSessionCreated: (kiloSessionId: KiloSessionId) => {
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          url.searchParams.set('sessionId', kiloSessionId);
          window.history.replaceState(window.history.state, '', url.toString());
        }
      },

      onRemoteSessionOpened: ({ kiloSessionId }) => {
        posthogRef.current?.capture('remote_session_opened', {
          feature: 'remote-session',
          kilo_session_id: kiloSessionId,
        });
      },
      onRemoteSessionMessageSent: ({ kiloSessionId }) => {
        posthogRef.current?.capture('remote_session_message_sent', {
          feature: 'remote-session',
          kilo_session_id: kiloSessionId,
        });
      },
    });
  }

  // Cleanup on unmount
  useEffect(() => {
    const manager = managerRef.current;
    return () => {
      manager?.destroy();
    };
  }, []);

  return (
    <JotaiProvider store={storeRef.current}>
      <ManagerContext.Provider value={managerRef.current}>{children}</ManagerContext.Provider>
    </JotaiProvider>
  );
}

export function useManager(): SessionManager {
  const manager = useContext(ManagerContext);
  if (!manager) throw new Error('useManager must be used within CloudAgentProvider');
  return manager;
}
