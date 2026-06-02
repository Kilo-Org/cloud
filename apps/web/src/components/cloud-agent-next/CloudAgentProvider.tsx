'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  createSessionManager,
  createBrowserLifecycleHooks,
  createUserWebConnection,
  type SessionManager,
  type SessionSnapshot,
  type ResolvedSession,
  type FetchedSessionData,
  type KiloSessionId,
  type CloudAgentSessionId,
  type TransportSendPayload,
  type UserWebConnection,
} from '@/lib/cloud-agent-sdk';
import type { SendMessagePayload } from '@/lib/cloud-agent-next/cloud-agent-client';
import { CLOUD_AGENT_NEXT_WS_URL, SESSION_INGEST_WS_URL } from '@/lib/constants';
import { usePostHog } from 'posthog-js/react';

const ManagerContext = createContext<SessionManager | null>(null);
const UserWebConnectionContext = createContext<UserWebConnection | null>(null);

type CloudAgentProviderProps = {
  children: ReactNode;
  organizationId?: string;
};

function normalizeTransportPayload(payload: TransportSendPayload): SendMessagePayload {
  // The transport-level SendPromptPayload makes mode/model optional (CLI
  // live transport accepts them as optional). The cloud-agent worker schema
  // requires them for prompts, so coerce here and fail loudly if missing.
  if (payload.type === 'prompt') {
    if (!payload.mode) throw new Error('Cloud Agent mode is required');
    if (!payload.model) throw new Error('Cloud Agent model is required');
    return {
      type: 'prompt',
      prompt: payload.prompt,
      mode: payload.mode,
      model: payload.model,
      variant: payload.variant,
    };
  }

  return {
    type: 'command',
    command: payload.command,
    arguments: payload.arguments,
  };
}

export function CloudAgentProvider({ children, organizationId }: CloudAgentProviderProps) {
  const storeRef = useRef(createStore());
  const trpcClient = useRawTRPCClient();
  const posthog = usePostHog();
  const posthogRef = useRef(posthog);
  posthogRef.current = posthog;

  const sharedConnectionRef = useRef<ReturnType<typeof createUserWebConnection> | null>(null);
  if (!SESSION_INGEST_WS_URL) {
    throw new Error('NEXT_PUBLIC_SESSION_INGEST_WS_URL is required for Cloud Agent sessions');
  }
  if (sharedConnectionRef.current === null) {
    sharedConnectionRef.current = createUserWebConnection({
      websocketUrl: `${SESSION_INGEST_WS_URL}/api/user/web`,
      getAuthToken: async () => {
        const result = await trpcClient.activeSessions.getToken.query();
        return result.token;
      },
      lifecycleHooks: createBrowserLifecycleHooks(),
    });
  }
  const sharedConnection = sharedConnectionRef.current;

  // Create manager once per provider instance.
  // trpcClient is stable (from context); organizationId is stable per provider mount.
  const managerRef = useRef<SessionManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = createSessionManager({
      store: storeRef.current,

      resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
        // 1. Check if the session is in the active sessions list (remote CLI)
        try {
          const active = await trpcClient.activeSessions.list.query();
          if (active.sessions.some(s => s.id === kiloSessionId)) {
            return { type: 'remote', kiloSessionId };
          }
        } catch {
          // Active sessions unavailable — fall through to other checks
        }

        // 2. Check if the session has a cloud agent session ID
        try {
          const session = await trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
          if (session.cloud_agent_session_id) {
            return {
              type: 'cloud-agent',
              kiloSessionId,
              cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId,
            };
          }
        } catch {
          // Session not found — fall through to read-only
        }

        // 3. Fallback: read-only historical session
        return { type: 'read-only', kiloSessionId };
      },

      getTicket: async (sessionId: CloudAgentSessionId) => {
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
        return (await response.json()) as { ticket: string; expiresAt: number };
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

      userWebConnection: sharedConnection,

      websocketBaseUrl: CLOUD_AGENT_NEXT_WS_URL,

      lifecycleHooks: createBrowserLifecycleHooks(),

      api: {
        send: async input => {
          const normalizedPayload = normalizeTransportPayload(input.payload);

          if (organizationId) {
            return trpcClient.organizations.cloudAgentNext.sendMessage.mutate(
              {
                cloudAgentSessionId: input.sessionId,
                payload: normalizedPayload,
                autoCommit: true,
                organizationId,
                messageId: input.messageId,
                attachments: input.attachments ?? input.images,
              },
              { context: { skipBatch: true } }
            );
          }
          return trpcClient.cloudAgentNext.sendMessage.mutate(
            {
              cloudAgentSessionId: input.sessionId,
              payload: normalizedPayload,
              autoCommit: true,
              messageId: input.messageId,
              attachments: input.attachments ?? input.images,
            },
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
        const castInput = {
          ...input,
          initialPayload: input.initialPayload
            ? normalizeTransportPayload(input.initialPayload)
            : undefined,
          mode: input.mode as AgentMode,
        };
        const result = organizationId
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
              ...castInput,
              organizationId,
            })
          : await trpcClient.cloudAgentNext.prepareSession.mutate(castInput);
        return {
          cloudAgentSessionId: result.cloudAgentSessionId as CloudAgentSessionId,
          kiloSessionId: result.kiloSessionId as KiloSessionId,
        };
      },

      initiate: async input => {
        if (organizationId) {
          return trpcClient.organizations.cloudAgentNext.initiateFromPreparedSession.mutate(
            {
              cloudAgentSessionId: input.cloudAgentSessionId,
              organizationId,
            },
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
          prompt: rs?.prompt ?? null,
          initialMessageId: rs?.initialMessageId ?? null,
          runtimeAgents: rs?.runtimeAgents,
          associatedPr: sessionResult.associatedPr,
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

  useEffect(() => {
    const manager = managerRef.current;
    const release = sharedConnection.retain();
    return () => {
      manager?.destroy();
      release();
    };
  }, [sharedConnection]);

  return (
    <JotaiProvider store={storeRef.current}>
      <UserWebConnectionContext.Provider value={sharedConnection}>
        <ManagerContext.Provider value={managerRef.current}>{children}</ManagerContext.Provider>
      </UserWebConnectionContext.Provider>
    </JotaiProvider>
  );
}

export function useManager(): SessionManager {
  const manager = useContext(ManagerContext);
  if (!manager) throw new Error('useManager must be used within CloudAgentProvider');
  return manager;
}

export function useUserWebConnection(): UserWebConnection | null {
  return useContext(UserWebConnectionContext);
}
