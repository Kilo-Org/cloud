import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import { findAgentBySlug } from './local-runtime-catalog-selection';

export type LocalSessionConfigModelSelection = {
  providerID: string;
  modelID: string;
  variant: string;
};

/**
 * Local session controller state. Lives entirely in the screen — never sent
 * to the server. `selectedFence` mirrors the live fence the controller is
 * tracking; `agentOverride` and `modelOverride` shadow the catalog default
 * while the user drafts a non-default selection.
 *
 * - `agentOverride === null` means "use the catalog's `defaultAgent`".
 * - `modelOverride === null` means "use `resolveInitialModelSelection(catalog, agent)`".
 *   When the active agent has a pinned model, the controller's reducer sets
 *   the override alongside the agent so the renderer's `isModelLocked` flag
 *   derives correctly.
 */
export type LocalSessionConfigSelection = {
  selectedFence: LocalRuntimeFence | null;
  agentOverride: string | null;
  modelOverride: LocalSessionConfigModelSelection | null;
};

export const INITIAL_LOCAL_SESSION_CONFIG_SELECTION: LocalSessionConfigSelection = {
  selectedFence: null,
  agentOverride: null,
  modelOverride: null,
};

type LocalSessionConfigSelectionAction =
  | { type: 'setFence'; fence: LocalRuntimeFence | null }
  | { type: 'selectAgent'; slug: string; catalog: LocalRuntimeCatalog }
  | { type: 'selectModel'; selection: LocalSessionConfigModelSelection }
  | { type: 'resetOverrides' };

const NO_MODEL_OVERRIDE: LocalSessionConfigModelSelection | null = null;

/**
 * Pure reducer for the screen's selection state. The hook is responsible for
 * dispatching `setFence` whenever the runtime-discovery query or the
 * catalog-driven view-model picks a fence, and the `selectAgent` /
 * `selectModel` actions always arrive with the live catalog so the reducer
 * never reads a stale agent definition.
 */
export function reduceLocalSessionConfigSelection(
  state: LocalSessionConfigSelection,
  action: LocalSessionConfigSelectionAction
): LocalSessionConfigSelection {
  switch (action.type) {
    case 'setFence': {
      if (action.fence === null) {
        if (
          state.selectedFence === null &&
          state.agentOverride === null &&
          state.modelOverride === null
        ) {
          return state;
        }
        return { selectedFence: null, agentOverride: null, modelOverride: null };
      }
      const current = state.selectedFence;
      if (
        current &&
        current.runtimeId === action.fence.runtimeId &&
        current.connectionId === action.fence.connectionId
      ) {
        return state;
      }
      // Switching fences (reconnect to a new socket, or a fresh auto-pick)
      // discards any user overrides so the renderer reverts to the catalog
      // defaults for the new runtime.
      return {
        selectedFence: {
          runtimeId: action.fence.runtimeId,
          connectionId: action.fence.connectionId,
        },
        agentOverride: null,
        modelOverride: null,
      };
    }
    case 'selectAgent': {
      const agent = findAgentBySlug(action.catalog, action.slug);
      if (!agent) {
        // Defensive: the picker should not surface unknown slugs. Drop the
        // override rather than keep a stale slug around.
        if (state.agentOverride === null) {
          return state;
        }
        return { ...state, agentOverride: null, modelOverride: NO_MODEL_OVERRIDE };
      }
      if (agent.model) {
        return {
          ...state,
          agentOverride: agent.slug,
          modelOverride: {
            providerID: agent.model.providerID,
            modelID: agent.model.modelID,
            variant: agent.variant ?? '',
          },
        };
      }
      // Agent is unpinned: keep the existing model override only if it is
      // still resolvable in the new catalog; otherwise drop it so the
      // renderer falls back to the catalog/agent default.
      if (state.modelOverride) {
        const override = state.modelOverride;
        const provider = action.catalog.models.providers.find(
          candidate => candidate.id === override.providerID
        );
        const model = provider?.models.find(candidate => candidate.id === override.modelID);
        if (!model) {
          return { ...state, agentOverride: agent.slug, modelOverride: null };
        }
        if (!model.variants.includes(override.variant)) {
          return {
            ...state,
            agentOverride: agent.slug,
            modelOverride: {
              providerID: override.providerID,
              modelID: override.modelID,
              variant: model.variants[0] ?? '',
            },
          };
        }
      }
      return { ...state, agentOverride: agent.slug };
    }
    case 'selectModel': {
      return { ...state, modelOverride: { ...action.selection } };
    }
    case 'resetOverrides': {
      if (state.agentOverride === null && state.modelOverride === null) {
        return state;
      }
      return { ...state, agentOverride: null, modelOverride: null };
    }
    default: {
      return state;
    }
  }
}
