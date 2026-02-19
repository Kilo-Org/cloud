/**
 * ProjectSession — owns the ProjectManager lifecycle.
 *
 * Creates the manager on mount, destroys on unmount,
 * and provides state via React Context for child components.
 * Uses useSyncExternalStore for React concurrent mode compatibility.
 */

'use client';

import React, {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { createProjectManager, type ProjectManager, type ProjectState } from './ProjectManager';
import type { ProjectWithMessages } from '@/lib/app-builder/types';

type ProjectContextValue = {
  manager: ProjectManager;
  state: ProjectState;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

type ProjectSessionProps = {
  project: ProjectWithMessages;
  organizationId: string | null;
  children: React.ReactNode;
};

export function ProjectSession({ project, organizationId, children }: ProjectSessionProps) {
  const trpcClient = useRawTRPCClient();

  const managerRef = useRef<ProjectManager | null>(null);
  const [managerVersion, setManagerVersion] = React.useState(0);

  // Create manager if needed (null or destroyed by Strict Mode cleanup)
  if (managerRef.current === null || managerRef.current.destroyed) {
    managerRef.current = createProjectManager({ project, trpcClient, organizationId });
  }

  const manager = managerRef.current;

  // Strict Mode: when manager is destroyed, force re-render to create a new one.
  useEffect(() => {
    if (manager.destroyed) {
      setManagerVersion(v => v + 1);
      return;
    }
    return () => {
      manager.destroy();
    };
  }, [manager, managerVersion]);

  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);

  const contextValue = useMemo<ProjectContextValue>(() => ({ manager, state }), [manager, state]);

  return <ProjectContext value={contextValue}>{children}</ProjectContext>;
}

/**
 * Access the ProjectManager instance for calling methods
 * (sendMessage, interrupt, deploy, etc.).
 */
export function useProjectManager(): ProjectManager {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjectManager must be used within a ProjectSession');
  }
  return context.manager;
}

/**
 * Access the current ProjectState (messages, isStreaming, previewUrl, etc.).
 * Automatically kept in sync via useSyncExternalStore.
 */
export function useProjectState(): ProjectState {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjectState must be used within a ProjectSession');
  }
  return context.state;
}

/** Access both the ProjectManager and current state. */
export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectSession');
  }
  return context;
}
