import { i18n } from '@/i18n';

import { stripModelPrefix } from './model-id';

/**
 * Kilo's own Auto models arrive from the gateway catalogue with an English
 * display name ("Auto Efficient") that no catalog translates, and the model
 * chip renders them beside localized controls. Resolve the label from the
 * catalogue by model id; any other model (a third party's, or a tier added
 * after this list) keeps the name the catalogue gave it.
 */
const AUTO_MODEL_NAME_KEYS = {
  'kilo-auto/frontier': 'models.auto.frontier',
  'kilo-auto/balanced': 'models.auto.balanced',
  'kilo-auto/efficient': 'models.auto.efficient',
  'kilo-auto/small': 'models.auto.small',
  'kilo-auto/free': 'models.auto.free',
  'kilo-auto/org': 'models.auto.organization',
} satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

/**
 * The label for a model id: its localized Auto-model name, or `fallbackName`
 * (the catalogue's own name) for every model the catalogue does not name.
 * KiloClaw stores the same ids with a `kilocode/` prefix, so look those up too.
 */
export function autoModelLabel(id: string, fallbackName: string): string {
  const key =
    lookup(AUTO_MODEL_NAME_KEYS, id) ?? lookup(AUTO_MODEL_NAME_KEYS, stripModelPrefix(id));
  return key ? i18n.t(key) : fallbackName;
}
