// The provider link a cut conversation shares between the Discussion footer's
// counted notice and an empty state's action slot, so the address, the label
// and the open handler stay one source.

import { useTranslation } from 'react-i18next';

import { StateAction } from '@/components/empty-state';
import { ExternalLink } from '@/components/ui/icons';
import { openExternalUrl } from '@/lib/external-link';
import {
  type ProviderPrRef,
  providerPrTermKey,
  providerPrWebUrl,
  providerViewOnLabel,
  useProviderPrWebUrl,
} from '@/lib/pr-review/provider-pr-ref';

/**
 * The provider link the notice and the empty body's action share: the address,
 * the label in the reader's provider terms and the open handler all resolve
 * here, so the two surfaces cannot drift apart. The footer's notice is the one
 * other consumer.
 */
export function useProviderPrLink(prRef: ProviderPrRef) {
  const { t } = useTranslation();
  const serverWebUrl = useProviderPrWebUrl();
  // GitHub and Bitbucket host every repository, so the ref alone is the whole
  // URL; GitLab needs the instance the read resolved, which is the published
  // one. The GitHub arm publishes null on purpose, so reading the context
  // alone would leave the one recovery affordance off the GitHub surface.
  const url = providerPrWebUrl({ ref: prRef, serverWebUrl });
  const label = providerViewOnLabel(t, prRef.platform);
  return {
    url,
    label,
    // Only a resolved URL is ever opened; a caller may hand this handler to a
    // control that renders on its own terms.
    open: () => {
      if (url !== null) {
        // "Could not open {{label}}" names the thing, not the action.
        void openExternalUrl(url, { label: t(providerPrTermKey(prRef.platform)) });
      }
    },
  };
}

/**
 * The empty body's way out when the server cut the conversation: the state's
 * own action slot carries the provider link, so the empty state keeps one
 * compact way out instead of an outlined button under a count it cannot show.
 */
export function ProviderViewAction({ prRef }: Readonly<{ prRef: ProviderPrRef }>) {
  const { url, label, open } = useProviderPrLink(prRef);
  if (url === null) {
    return null;
  }
  return <StateAction label={label} icon={ExternalLink} onPress={open} />;
}
