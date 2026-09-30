const CURRENT_MODEL_LATEST_ALIASES = {
  claudeOpus: '~anthropic/claude-opus-latest',
  claudeSonnet: '~anthropic/claude-sonnet-latest',
  gptSol: '~openai/gpt-sol-latest',
  glm: '~z-ai/glm-latest',
  glmFlash: '~z-ai/glm-flash-latest',
  kimi: '~moonshotai/kimi-latest',
} as const;

export type CurrentModelFamily = keyof typeof CURRENT_MODEL_LATEST_ALIASES;

export type CurrentModelIds = Readonly<Record<CurrentModelFamily, string>>;

/**
 * Used until the synchronized OpenRouter catalog resolves the latest aliases,
 * and wherever a deterministic id is required.
 */
export const FALLBACK_CURRENT_MODEL_IDS = {
  claudeOpus: 'anthropic/claude-opus-5.5',
  claudeSonnet: 'anthropic/claude-sonnet-5.5',
  gptSol: 'openai/gpt-6.1-sol',
  glm: 'z-ai/glm-5.3',
  glmFlash: 'z-ai/glm-5.3-flash',
  kimi: 'moonshotai/kimi-k3',
} as const satisfies CurrentModelIds;

type CatalogModel = { alias_target?: { slug: string } };

/** Resolves each family to its OpenRouter latest alias target, if the catalog lists that target. */
export function resolveCurrentModelIds(
  catalog: Readonly<Record<string, CatalogModel | undefined>>
): CurrentModelIds {
  const resolve = (family: CurrentModelFamily) => {
    const target = catalog[CURRENT_MODEL_LATEST_ALIASES[family]]?.alias_target?.slug;
    return target && catalog[target] ? target : FALLBACK_CURRENT_MODEL_IDS[family];
  };
  return {
    claudeOpus: resolve('claudeOpus'),
    claudeSonnet: resolve('claudeSonnet'),
    gptSol: resolve('gptSol'),
    glm: resolve('glm'),
    glmFlash: resolve('glmFlash'),
    kimi: resolve('kimi'),
  };
}
