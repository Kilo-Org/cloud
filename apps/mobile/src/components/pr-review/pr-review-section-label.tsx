import { Text } from '@/components/ui/text';

/**
 * A same-level heading of the pull-request overview: DESCRIPTION, CHECKS and
 * the meta labels (LABELS, REVIEWERS, …). The three used to carry their own
 * inline `Text`, and one of them drifted to the body `small` variant, so the
 * headings on one screen no longer looked alike. They render through this
 * element so they cannot diverge again.
 */
export function PrReviewSectionLabel({ label }: Readonly<{ label: string }>) {
  // The eyebrow variant owns the 10pt mono capitals and their tracking, so the
  // heading is that one line and nothing else.
  return <Text variant="eyebrow">{label}</Text>;
}
