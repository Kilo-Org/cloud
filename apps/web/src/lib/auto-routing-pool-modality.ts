export const INPUT_MODALITY_VOCABULARY = ['text', 'image', 'file', 'audio', 'video'] as const;

export type InputModality = (typeof INPUT_MODALITY_VOCABULARY)[number];

// The auto-routing worker fails closed on these only
// (services/auto-routing/src/decision-engine.ts ENFORCED_MODALITIES). A request
// that needs one of them and finds no supporting pool model gets no decision
// and the gateway falls back to the default model. Required modalities outside
// this set are ignored by the router, so a gap there means the pool cannot
// serve the input but does not by itself change routing.
export const ENFORCED_INPUT_MODALITIES: ReadonlyArray<InputModality> = ['image', 'file'];

export type ModalityCatalogModel = {
  id: string;
  inputModalities?: readonly string[] | null;
};

export type PoolModalityCoverage =
  | { status: 'covered' }
  | { status: 'pending' }
  | { status: 'missing'; missing: InputModality[] }
  | { status: 'unknown'; unknownModelIds: string[] };

function recognizedModalities(
  values: readonly string[] | null | undefined
): InputModality[] | null {
  if (values == null) return null;
  return INPUT_MODALITY_VOCABULARY.filter(modality => values.includes(modality));
}

export function computePoolModalityCoverage(params: {
  poolModelIds: readonly string[];
  catalog: readonly ModalityCatalogModel[] | null;
}): PoolModalityCoverage {
  if (params.catalog === null) return { status: 'pending' };
  const catalogById = new Map<string, InputModality[] | null>();
  const mattered = new Set<InputModality>();
  for (const entry of params.catalog) {
    const modalities = recognizedModalities(entry.inputModalities);
    catalogById.set(entry.id, modalities);
    if (modalities) {
      for (const modality of modalities) mattered.add(modality);
    }
  }

  const poolModelIds = [...new Set(params.poolModelIds)];
  if (poolModelIds.length === 0) {
    return { status: 'covered' };
  }

  const unknownModelIds = poolModelIds.filter(id => {
    const modalities = catalogById.get(id);
    return modalities === undefined || modalities === null;
  });
  if (unknownModelIds.length > 0) {
    return { status: 'unknown', unknownModelIds };
  }

  const accepted = new Set<InputModality>();
  for (const id of poolModelIds) {
    for (const modality of catalogById.get(id) ?? []) accepted.add(modality);
  }

  const missing = INPUT_MODALITY_VOCABULARY.filter(
    modality => mattered.has(modality) && !accepted.has(modality)
  );
  return missing.length > 0 ? { status: 'missing', missing: [...missing] } : { status: 'covered' };
}

export function formatModalityList(modalities: readonly InputModality[]): string {
  if (modalities.length <= 1) return modalities[0] ?? '';
  if (modalities.length === 2) return `${modalities[0]} or ${modalities[1]}`;
  const head = modalities.slice(0, -1).join(', ');
  return `${head}, or ${modalities[modalities.length - 1]}`;
}

export function poolModalityWarningMessage(missing: readonly InputModality[]): string {
  if (missing.length === 0) return '';
  const base = `No model in this pool accepts ${formatModalityList(missing)} input.`;
  const enforcedMissing = missing.filter(modality => ENFORCED_INPUT_MODALITIES.includes(modality));
  if (enforcedMissing.length === 0) return base;
  const enforcedList = formatModalityList(enforcedMissing);
  return `${base} Requests with ${enforcedList} input fall back to the default model.`;
}

export function poolModalityUnknownMessage(unknownModelIds: readonly string[]): string {
  const count = unknownModelIds.length;
  const models = count === 1 ? '1 model is' : `${count} models are`;
  return `Modality coverage is unknown: ${models} not in the model catalog.`;
}
