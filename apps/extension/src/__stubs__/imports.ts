import type { AgentWorkflowsStorageArea } from '@/src/shared/agent-workflows-storage';

/** Test-only stub for WXT `#imports`. Tests replace this with vi.mock. */
export const storage: AgentWorkflowsStorageArea = {
  getItem: () => null,
  removeItem: () => {},
  setItem: () => {},
};
