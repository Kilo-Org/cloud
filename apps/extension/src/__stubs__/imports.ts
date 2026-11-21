import type { AgentWorkflowsStorageArea } from '@/src/shared/agent-workflows-storage';
import type { LocalAgentStorageWatch } from '@/src/shared/local-agents/storage';

/**
 * Test-only stub for WXT `#imports`. Tests replace this with vi.mock.
 * `watch` mirrors the WXT storage surface the local-agents host subscribes to.
 */
export const storage: AgentWorkflowsStorageArea & { watch: LocalAgentStorageWatch } = {
  getItem: () => null,
  removeItem: () => {},
  setItem: () => {},
  watch: () => () => {},
};
