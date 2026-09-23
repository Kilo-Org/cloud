import { formatShortModelDisplayName } from '@/lib/model-display-name';

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
  /** `t('common.model')`: the label when nothing else can be resolved. */
  fallbackLabel: string;
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
 * model reference.
 */
export function resolveModelSelectorLabel(input: ModelSelectorLabelInput): string {
  if (input.selectedName !== undefined) {
    return input.selectedName;
  }
  if (!input.providerAware && input.value !== '') {
    const shortName = formatShortModelDisplayName(input.value);
    if (shortName !== '') {
      return shortName;
    }
  }
  return input.fallbackLabel;
}
