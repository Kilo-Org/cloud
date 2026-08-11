export type ModelAccessPolicyExemptModel = {
  id: string;
  name: string;
  source: 'direct_byok' | 'custom_llm';
};

type ModelSummary = Pick<ModelAccessPolicyExemptModel, 'id' | 'name'>;

export function buildModelAccessPolicyExemptModels(
  directByokModels: readonly ModelSummary[],
  customLlms: readonly ModelSummary[]
): ModelAccessPolicyExemptModel[] {
  return [
    ...directByokModels.map(model => ({ ...model, source: 'direct_byok' as const })),
    ...customLlms.map(model => ({ ...model, source: 'custom_llm' as const })),
  ].sort(
    (a, b) =>
      Number(a.source === 'custom_llm') - Number(b.source === 'custom_llm') ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  );
}
