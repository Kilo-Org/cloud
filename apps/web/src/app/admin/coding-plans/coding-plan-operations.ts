// Provider-aware copy helpers for the Coding Plans admin operations page.
// Provider names resolve from the Coding Plan catalog; historical or unknown
// rows fall back to the raw provider ID so operations copy never names the
// wrong provider.

export type CodingPlanProviderNameSource = {
  providerId: string;
  providerName: string;
};

export function getCodingPlanProviderDisplayName(
  catalog: readonly CodingPlanProviderNameSource[],
  providerId: string
): string {
  return catalog.find(entry => entry.providerId === providerId)?.providerName ?? providerId;
}

export function getRevocationCompleteToast(providerDisplayName: string | null): string {
  return providerDisplayName
    ? `${providerDisplayName} credential removed from stock.`
    : 'Credential removed from stock.';
}

export function getReplacementCompleteToast(providerDisplayName: string | null): string {
  return providerDisplayName
    ? `${providerDisplayName} credential replaced and returned to stock.`
    : 'Credential replaced and returned to stock.';
}

export function getRevocationDialogCopy(providerDisplayName: string): {
  title: string;
  description: string;
} {
  return {
    title: `Revoke ${providerDisplayName} credential?`,
    description: `Use this only when ${providerDisplayName} access should be completely removed from stock. Kilo records the plan ID as revoked and keeps this credential unavailable for reuse.`,
  };
}

export function getReplacementDialogCopy(providerDisplayName: string): {
  title: string;
  description: string;
  placeholder: string;
} {
  return {
    title: `Replace ${providerDisplayName} API key`,
    description: `Paste the newly generated ${providerDisplayName} API key for this same upstream plan ID. Kilo validates the key before returning this plan to available inventory.`,
    placeholder: `Paste new ${providerDisplayName} API key`,
  };
}
