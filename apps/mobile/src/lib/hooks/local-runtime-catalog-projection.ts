import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

import { type LocalRuntimeCatalog } from './local-runtime-catalog-types';

type RouterOutputs = inferRouterOutputs<RootRouter>;

/**
 * Pure projection from the tRPC `localRuntimeControl.getCatalog` wire shape to
 * the mobile-facing `LocalRuntimeCatalog`. The wire type is owned by the web
 * client and carries extra model metadata (`capabilities`, `limits`) and an
 * untyped agent `model` field. The mobile slice only needs the subset it
 * renders, and it narrows the optional agent model to the exact provider/model
 * pair it consumes.
 */
export function projectLocalRuntimeCatalog(
  output: RouterOutputs['localRuntimeControl']['getCatalog']
): LocalRuntimeCatalog {
  return {
    protocolVersion: output.protocolVersion,
    models: {
      protocolVersion: output.models.protocolVersion,
      providers: output.models.providers.map(provider => ({
        id: provider.id,
        name: provider.name,
        models: provider.models.map(model => ({
          id: model.id,
          name: model.name,
          recommendedIndex: model.recommendedIndex,
          isFree: model.isFree,
          mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
          hasUserByokAvailable: model.hasUserByokAvailable,
          variants: model.variants,
        })),
      })),
      defaultModel: output.models.defaultModel,
      truncated: output.models.truncated,
    },
    agents: output.agents.map(agent => ({
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      model: narrowAgentModel(agent.model),
      variant: agent.variant,
    })),
    defaultAgent: output.defaultAgent,
  };
}

function narrowAgentModel(model: unknown): { providerID: string; modelID: string } | undefined {
  if (model === null || typeof model !== 'object') {
    return undefined;
  }
  const candidate = model as { providerID?: unknown; modelID?: unknown };
  if (typeof candidate.providerID === 'string' && typeof candidate.modelID === 'string') {
    return { providerID: candidate.providerID, modelID: candidate.modelID };
  }
  return undefined;
}
