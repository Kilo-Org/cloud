import { Text } from '@/components/ui/text';
import { type ProviderPrRef, providerPrRefLabel } from '@/lib/pr-review/provider-pr-ref';
import { LTR_TEXT_DIRECTION } from '@/lib/rtl-text';

/**
 * Which PR/MR a connect gate is about: the repository and number the route
 * already carries, in the app's one identifier format (`owner/repo#7`,
 * `group/sub/repo!12` — the same label the sheet eyebrows, the inbox rows and
 * the recents show).
 *
 * The reader reached this gate from a specific link, and the gate's copy is
 * provider-generic ("Connect GitHub", "… to review pull requests on mobile"),
 * so without this line a teammate's PR is indistinguishable from any other
 * while the user decides whether to connect. No ref means no known item (the
 * entry route's pass-through mount), and the gate stays exactly as it was.
 *
 * One line: a long nested GitLab project path must not wrap and push the copy
 * and the CTA down. The ellipsis sits in the middle, because the number and
 * the last path segment are what tell two MRs of one group apart. The label is
 * an identifier, not copy, so it keeps a left-to-right base direction under an
 * RTL locale (`LTR_TEXT_DIRECTION`) while staying centered.
 *
 * It sits directly under the gate's title, so it takes the body size in the
 * secondary color: an identifier at full strength there competes with the
 * title, which is the line the reader has to read first.
 */
export function PrReviewGateItemLine({ prRef }: Readonly<{ prRef?: ProviderPrRef }>) {
  if (!prRef) {
    return null;
  }
  return (
    <Text
      variant="mono"
      className="max-w-full text-center text-sm text-muted-foreground"
      numberOfLines={1}
      ellipsizeMode="middle"
      style={LTR_TEXT_DIRECTION}
    >
      {providerPrRefLabel(prRef)}
    </Text>
  );
}
