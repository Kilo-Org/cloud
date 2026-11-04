import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { DIRECT_BYOK_PROVIDERS_META } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';

const DIRECT_BYOK_PROVIDER_PREFIXES = new Set(
  Object.keys(DIRECT_BYOK_PROVIDERS_META).map(id => `${id}/`)
);

type SelectorListModel = {
  id: string;
  name: string;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  isCustomLlm?: boolean;
  opencode?: { variants?: Record<string, unknown> } | null;
};

/**
 * Direct-BYOK-only catalog entries use a direct-BYOK provider id prefix (`chutes-byok/…`) and are
 * always marked `hasUserByokAvailable`. Managed models may also carry the flag when the user has a
 * matching key; those stay eligible.
 */
function isDirectByokOnlyModel(model: SelectorListModel): boolean {
  if (model.hasUserByokAvailable !== true) return false;
  const slash = model.id.indexOf('/');
  if (slash <= 0) return false;
  return DIRECT_BYOK_PROVIDER_PREFIXES.has(model.id.slice(0, slash + 1));
}

function isEligibleBenchmarkModel(model: SelectorListModel): boolean {
  return (
    model.id.length > 0 &&
    !isVirtualAutoModelId(model.id) &&
    !model.isCustomLlm &&
    !isDirectByokOnlyModel(model)
  );
}

export function toEligibleModelOptions(models: SelectorListModel[]): ModelOption[] {
  return models.filter(isEligibleBenchmarkModel).map(model => {
    const variantKeys = model.opencode?.variants
      ? Object.keys(model.opencode.variants).filter(key => key.trim().length > 0)
      : [];
    return {
      id: model.id,
      name: model.name,
      isFree: model.isFree,
      mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
      hasUserByokAvailable: model.hasUserByokAvailable,
      variants: variantKeys.length > 0 ? variantKeys : undefined,
    };
  });
}
