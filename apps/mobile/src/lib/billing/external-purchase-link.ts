import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import {
  cachedStorefrontCountry,
  readStorefrontCountry,
  US_STOREFRONT_COUNTRY,
} from '@/lib/billing/storefront-country';

/**
 * Whether a surface may draw an in-app link to a web page that sells or manages
 * a purchase.
 *
 * One combination may: an iOS build whose App Store storefront is the United
 * States, where guideline 3.1.1(a) permits the link. Every other combination —
 * another storefront, a storefront the store did not answer for, and Android,
 * which is not enrolled in any external-content-links programme — shows the
 * destination as plain text with no control to press.
 */
export function canLinkExternalPurchase(
  platformOS: string,
  storefrontCountry: string | null
): boolean {
  return platformOS === 'ios' && storefrontCountry === US_STOREFRONT_COUNTRY;
}

/**
 * The rule above for a rendered surface, with the storefront read it needs.
 *
 * The read is asynchronous while a link decision is needed on the first frame,
 * so every unsettled case renders plain text: a pending read, a failed read and
 * a country the store did not name. A country the store did answer with is kept
 * for the session, so later surfaces paint settled on their first frame; a
 * failure is not kept, and the next mount asks again. Android never asks the
 * store, because no storefront may show the link there.
 */
export function useCanLinkExternalPurchase(): boolean {
  const platformOS = Platform.OS;
  const [storefrontCountry, setStorefrontCountry] = useState<string | null>(() =>
    platformOS === 'ios' ? cachedStorefrontCountry() : null
  );

  useEffect(() => {
    if (platformOS !== 'ios' || storefrontCountry != null) {
      return;
    }
    let active = true;
    void readStorefrontCountry().then(country => {
      if (active && country != null) {
        setStorefrontCountry(country);
      }
    });
    return () => {
      active = false;
    };
  }, [platformOS, storefrontCountry]);

  return canLinkExternalPurchase(platformOS, storefrontCountry);
}
