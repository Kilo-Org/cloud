import { formatModelReferenceName, formatShortModelDisplayName } from '@/lib/model-display-name';

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
 * model reference: a `vendor/model` reference the catalog does not carry falls
 * back to its readable last segment.
 */
export function resolveModelSelectorLabel(input: ModelSelectorLabelInput): string {
  if (input.selectedName !== undefined) {
    return input.selectedName;
  }
  if (!input.providerAware && input.value !== '') {
    const shortName = formatShortModelDisplayName(input.value);
    if (shortName !== '') {
      // A `vendor/model` reference is an id, not copy: show its readable last
      // segment. The chip read `deepseek/deepseek-v4.1-flash-1017` on a session
      // whose picker named the same model `DeepSeek V4.1 Flash 1017`.
      return shortName.includes('/') ? formatModelReferenceName(shortName) : shortName;
    }
  }
  return input.fallbackLabel;
}
