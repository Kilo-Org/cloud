import { describe, expect, test } from '@jest/globals';
import type { Owner } from '@/lib/integrations/core/types';
import {
  buildSelectableCloudAgentModelCatalog,
  resolveCloudAgentModel,
  type CloudAgentModelCatalogDeps,
  type SelectCloudAgentModel,
} from './cloud-agent-model-selection';

const userOwner: Owner = { type: 'user', id: 'user-1' };
const orgOwner: Owner = { type: 'org', id: 'org-1' };

const baseSonnetModel = {
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Claude Sonnet 4.5',
  preferredIndex: 0,
};

const baseOpusModel = {
  id: 'anthropic/claude-opus-4.7',
  name: 'Claude Opus 4.7',
  preferredIndex: 1,
};

type TestModel = { id: string; name: string; created?: number; preferredIndex?: number };

function createDeps(params: {
  baseModels?: TestModel[];
  organizationByokModels?: TestModel[];
  userByokModels?: TestModel[];
  organizationCustomModels?: TestModel[];
  deniedModels?: string[];
}): CloudAgentModelCatalogDeps {
  const deniedModels = new Set(params.deniedModels ?? []);
  return {
    getBaseModels: async () => params.baseModels ?? [],
    getOrganizationByokModels: async () => params.organizationByokModels ?? [],
    getUserByokModels: async () => params.userByokModels ?? [],
    getOrganizationCustomModels: async () => params.organizationCustomModels ?? [],
    getOrganizationModelPolicy: async () => ({
      isAllowed: async modelId => !deniedModels.has(modelId),
    }),
  };
}

describe('resolveCloudAgentModel', () => {
  test('missing modelRequest returns the default model without loading catalog', async () => {
    let loadedCatalog = false;
    let calledSelector = false;
    const selectModel: SelectCloudAgentModel = async () => {
      calledSelector = true;
      return { selectedModelId: null, confidence: 'low', reason: 'not called', alternatives: [] };
    };

    const result = await resolveCloudAgentModel({
      modelRequest: undefined,
      defaultModel: 'anthropic/default-model',
      prompt: 'Fix the bug',
      owner: userOwner,
      selectModel,
      catalogDeps: {
        getBaseModels: async () => {
          loadedCatalog = true;
          return [baseSonnetModel];
        },
      },
    });

    expect(result).toEqual({ ok: true, model: 'anthropic/default-model' });
    expect(loadedCatalog).toBe(false);
    expect(calledSelector).toBe(false);
  });

  test('exact available model ID is used without calling selector', async () => {
    let calledSelector = false;
    const selectModel: SelectCloudAgentModel = async () => {
      calledSelector = true;
      return {
        selectedModelId: baseSonnetModel.id,
        confidence: 'high',
        reason: 'not called',
        alternatives: [],
      };
    };

    const result = await resolveCloudAgentModel({
      modelRequest: baseOpusModel.id,
      defaultModel: baseSonnetModel.id,
      prompt: 'Fix the bug',
      owner: userOwner,
      selectModel,
      catalogDeps: createDeps({ baseModels: [baseSonnetModel, baseOpusModel] }),
    });

    expect(result).toEqual({ ok: true, model: baseOpusModel.id });
    expect(calledSelector).toBe(false);
  });

  test('natural-language family request delegates to selector for multilingual matching', async () => {
    let calledSelector = false;
    const result = await resolveCloudAgentModel({
      modelRequest: 'usa el modelo opus mas reciente',
      defaultModel: baseSonnetModel.id,
      prompt: 'Fix the bug',
      owner: userOwner,
      selectModel: async () => {
        calledSelector = true;
        return {
          selectedModelId: baseOpusModel.id,
          confidence: 'high',
          reason: 'latest opus requested in Spanish',
          alternatives: [],
        };
      },
      catalogDeps: createDeps({ baseModels: [baseSonnetModel, baseOpusModel] }),
    });

    expect(result).toEqual({ ok: true, model: baseOpusModel.id });
    expect(calledSelector).toBe(true);
  });

  test('falls back to direct catalog matching when selector is low confidence', async () => {
    let calledSelector = false;
    const opus3Model = {
      id: 'anthropic/claude-3-opus',
      name: 'Claude 3 Opus',
    };
    const opus4Model = {
      id: 'anthropic/claude-opus-4',
      name: 'Claude Opus 4',
    };

    const result = await resolveCloudAgentModel({
      modelRequest: 'latest version of opus',
      defaultModel: baseSonnetModel.id,
      prompt: 'Fix the bug',
      owner: userOwner,
      selectModel: async () => {
        calledSelector = true;
        return {
          selectedModelId: null,
          confidence: 'low',
          reason: 'fallback test',
          alternatives: [],
        };
      },
      catalogDeps: createDeps({ baseModels: [opus3Model, opus4Model, baseOpusModel] }),
    });

    expect(result).toEqual({ ok: true, model: baseOpusModel.id });
    expect(calledSelector).toBe(true);
  });

  test('falls back to exact version-like catalog matching when selector is low confidence', async () => {
    const minimaxM25Model = {
      id: 'minimax/minimax-m2.5',
      name: 'MiniMax M2.5',
    };
    const minimaxM27Model = {
      id: 'minimax/minimax-m2.7',
      name: 'MiniMax M2.7',
    };

    const result = await resolveCloudAgentModel({
      modelRequest: 'minimax m2.5',
      defaultModel: baseSonnetModel.id,
      prompt: 'Fix the bug',
      owner: userOwner,
      selectModel: async () => ({
        selectedModelId: null,
        confidence: 'low',
        reason: 'fallback test',
        alternatives: [],
      }),
      catalogDeps: createDeps({ baseModels: [minimaxM27Model, minimaxM25Model] }),
    });

    expect(result).toEqual({ ok: true, model: minimaxM25Model.id });
  });

  test('falls back to current family model when requested version is unavailable', async () => {
    const minimaxM27Model = {
      id: 'minimax/minimax-m2.7',
      name: 'MiniMax M2.7',
      preferredIndex: 0,
    };
    const minimaxM1Model = {
      id: 'minimax/minimax-m1',
      name: 'MiniMax M1',
    };

    const result = await resolveCloudAgentModel({
      modelRequest: 'minimax m2.5',
      defaultModel: baseSonnetModel.id,
      prompt: 'Fix the bug',
      owner: userOwner,
      selectModel: async () => ({
        selectedModelId: null,
        confidence: 'low',
        reason: 'fallback test',
        alternatives: [],
      }),
      catalogDeps: createDeps({ baseModels: [minimaxM1Model, minimaxM27Model] }),
    });

    expect(result).toEqual({ ok: true, model: minimaxM27Model.id });
  });

  test('rejects an LLM-selected model that is not in the catalog', async () => {
    const result = await resolveCloudAgentModel({
      modelRequest: 'best coding model',
      defaultModel: baseSonnetModel.id,
      prompt: 'Implement a feature',
      owner: userOwner,
      selectModel: async () => ({
        selectedModelId: 'anthropic/nonexistent-model',
        confidence: 'high',
        reason: 'bad selection',
        alternatives: [baseSonnetModel.id],
      }),
      catalogDeps: createDeps({ baseModels: [baseSonnetModel] }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toContain('selector chose unavailable model');
      expect(result.response).toContain(baseSonnetModel.id);
    }
  });

  test('returns a clarification error for low-confidence or no-match selections', async () => {
    const result = await resolveCloudAgentModel({
      modelRequest: 'the meadow model',
      defaultModel: baseSonnetModel.id,
      prompt: 'Explain the code',
      owner: userOwner,
      selectModel: async () => ({
        selectedModelId: null,
        confidence: 'low',
        reason: 'ambiguous',
        alternatives: [baseOpusModel.id],
      }),
      catalogDeps: createDeps({ baseModels: [baseSonnetModel, baseOpusModel] }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toContain('could not confidently match');
      expect(result.response).toContain(baseOpusModel.id);
    }
  });

  test('rejects org-denied models even if the selector chooses them', async () => {
    const result = await resolveCloudAgentModel({
      modelRequest: 'opus',
      defaultModel: baseSonnetModel.id,
      prompt: 'Fix a complex bug',
      owner: orgOwner,
      selectModel: async () => ({
        selectedModelId: baseOpusModel.id,
        confidence: 'high',
        reason: 'requested opus',
        alternatives: [baseSonnetModel.id],
      }),
      catalogDeps: createDeps({
        baseModels: [baseSonnetModel, baseOpusModel],
        deniedModels: [baseOpusModel.id],
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toContain('selector chose unavailable model');
      expect(result.response).toContain(baseSonnetModel.id);
    }
  });
});

describe('buildSelectableCloudAgentModelCatalog', () => {
  test('includes organization BYOK and custom LLM models for org-owned integrations', async () => {
    const catalog = await buildSelectableCloudAgentModelCatalog(
      orgOwner,
      createDeps({
        baseModels: [baseSonnetModel],
        organizationByokModels: [{ id: 'openai/gpt-5', name: 'OpenAI: GPT-5' }],
        userByokModels: [{ id: 'mistral/codestral', name: 'Mistral: Codestral' }],
        organizationCustomModels: [{ id: 'custom/org-model', name: 'Org Custom Model' }],
      })
    );

    expect(catalog.map(model => model.id)).toEqual([
      baseSonnetModel.id,
      'openai/gpt-5',
      'custom/org-model',
    ]);
  });

  test('includes user BYOK models for user-owned integrations', async () => {
    const catalog = await buildSelectableCloudAgentModelCatalog(
      userOwner,
      createDeps({
        baseModels: [baseSonnetModel],
        organizationByokModels: [{ id: 'openai/gpt-5', name: 'OpenAI: GPT-5' }],
        userByokModels: [{ id: 'mistral/codestral', name: 'Mistral: Codestral' }],
        organizationCustomModels: [{ id: 'custom/org-model', name: 'Org Custom Model' }],
      })
    );

    expect(catalog.map(model => model.id)).toEqual([baseSonnetModel.id, 'mistral/codestral']);
  });
});
