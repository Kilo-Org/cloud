// The provider's own noun in sentence form (s6). The `prReview.terms.*`
// labels are capitalized for chips and headers, so a mid-sentence
// `{{term}}` interpolation rides the lowercase `common.*` nouns instead —
// "Merge Merge request?" never renders. Standalone (no React imports) so
// the merge sheet, the merge screen and the overview's provider merge arm
// share the one mapping without pulling each other's bundles together.

import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';

export function providerPrNounKey(
  platform: ProviderPrPlatform
): 'common.mergeRequest' | 'common.pullRequest' {
  return platform === 'gitlab' ? 'common.mergeRequest' : 'common.pullRequest';
}
