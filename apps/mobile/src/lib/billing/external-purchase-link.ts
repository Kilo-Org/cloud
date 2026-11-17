import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { canLinkExternalPurchase } from '@/lib/billing/external-purchase-rule';
import { cachedStorefrontCountry, readStorefrontCountry } from '@/lib/billing/storefront-country';

/**
 * The storefront rule for a rendered surface, with the read it needs.
 *
 * The read is asynchronous while a link decision is needed on the first frame,
 * so every unsettled case renders plain text: a pending read, a failed read and
 * a country the store did not name. A country the store did answer with is kept
 * for the session, so later surfaces paint settled on their first frame; a
 * failure is not kept, and the next mount asks again, while a read that missed
 * the store deadline stops further reads for the process. Android never asks
 * the store, because no storefront may show the link there.
 */
export function useCanLinkExternalPurchase(): boolean {
  const platformOS = Platform.OS;
  const [storefrontCountry, setStorefrontCountry] = useState<string | null>(() =>
    platformOS === 'ios' ? cachedStorefrontCountry() : null
  );

  useEffect(() => {
    if (platformOS !== 'ios' || storefrontCountry != null) {
      return undefined;
    }
    let active = true;
    const read = async () => {
      const country = await readStorefrontCountry();
      if (active && country != null) {
        setStorefrontCountry(country);
      }
    };
    void read();
    return () => {
      active = false;
    };
  }, [platformOS, storefrontCountry]);

  return canLinkExternalPurchase(platformOS, storefrontCountry);
}
