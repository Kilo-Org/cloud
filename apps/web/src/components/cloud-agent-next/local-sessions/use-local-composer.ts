'use client';

import { useCallback, useLayoutEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { SessionManager } from '@kilocode/cloud-agent-sdk';
import { useLocalSessions } from './LocalSessionsProvider';
import type { LocalComposerSettings, LocalSession } from './local-session';

export function useLocalComposer(manager: SessionManager, session: LocalSession | null) {
  const { setLocalComposer } = useLocalSessions();
  const sessionConfig = useAtomValue(manager.atoms.sessionConfig);
  const fetchedSessionData = useAtomValue(manager.atoms.fetchedSessionData);
  const setSessionConfig = useSetAtom(manager.atoms.sessionConfig);
  const composer = session?.request.kind === 'worktree-chat' ? session.composer : null;

  useLayoutEffect(() => {
    if (
      !session ||
      !composer ||
      !sessionConfig ||
      fetchedSessionData?.kiloSessionId !== session.kiloSessionId ||
      sessionConfig.sessionId !== fetchedSessionData.cloudAgentSessionId
    )
      return;

    setSessionConfig({
      ...sessionConfig,
      mode: composer.mode,
      model: composer.model,
      variant: composer.variant,
    });
    manager.setCloudAgentModelOverride({
      model: composer.model,
      variant: composer.variant ?? undefined,
    });
    setLocalComposer(session.kiloSessionId, null);
  }, [
    composer,
    fetchedSessionData,
    manager,
    session,
    sessionConfig,
    setLocalComposer,
    setSessionConfig,
  ]);

  const updateComposer = useCallback(
    (next: LocalComposerSettings) => {
      if (session && composer) setLocalComposer(session.kiloSessionId, next);
    },
    [composer, session, setLocalComposer]
  );

  return { composer, updateComposer };
}
