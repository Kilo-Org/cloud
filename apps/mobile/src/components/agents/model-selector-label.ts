import { modelReferenceLabel } from '@/lib/model-display-name';

type ModelSelectorLabelInput = {
  /** The catalog option's display name, when the value matches one. */
  selectedName: string | undefined;
  /** The session's stored model reference or id. */
  value: string;
  /**
   * True when the options carry CLI-catalog refs. The chip then cannot know a
   * human name for an unmatched value and falls back to the generic label.
   */
  providerAware: boolean;
  /** `t('common.model')`: the label for a stored value nothing can name. */
  fallbackLabel: string;
  /** `t('common.notSelected')`: the label while no model is chosen at all. */
  notSelectedLabel: string;
};

/**
 * The label for the `ModelSelector` chip.
 *
 * A session can report a model the local catalog does not carry (a CLI build
 * ahead of the app's list), and the stored reference then arrives as the full
 * `<Vendor>: <Model>` display name. Printing it verbatim repeats the vendor in
 * user-facing copy — the chip read `DeepSeek: DeepSeek V4 Flash 0731` (explorer
 * session-typed-kb-up) — so the chip falls back to the same short name the
 * model picker shows. Mirrors the web chat toolbar, which never renders the raw
 * model reference: a `vendor/model` reference the catalog does not carry falls
 * back to `modelReferenceLabel`, the one readable rule the catalogue-backed rows
 * (`modelLabelFromCatalogue`) also use.
 */
export function resolveModelSelectorLabel(input: ModelSelectorLabelInput): string {
  if (input.selectedName !== undefined) {
    return input.selectedName;
  }
  if (input.value === '') {
    // Nothing is chosen. The field's own label already reads "Model", so the
    // value says that no model is chosen instead of repeating the label as if
    // it were a choice.
    return input.notSelectedLabel;
  }
  if (!input.providerAware) {
    const referenceLabel = modelReferenceLabel(input.value);
    if (referenceLabel !== '') {
      // A `vendor/model` reference is an id, not copy: `modelReferenceLabel`
      // shows its readable last segment, the same rule every other row uses.
      // The chip read `deepseek/deepseek-v4.1-flash-1017` on a session whose
      // picker named the same model `DeepSeek V4.1 Flash 1017`.
      return referenceLabel;
    }
  }
  return input.fallbackLabel;
}
