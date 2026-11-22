// The notice above the tab control is the form's only way to say its provider
// data is short: the catalog request failed, the catalog loaded without naming
// a provider, or the rows are empty. A saved slug gives the list a row to hold,
// so the last two are different states even though the copy is the same.

import { describe, expect, it } from 'vitest';

import { providerDataNotice } from '@/lib/organization/model-access-form-state';

/** The full set of facts the notice reads, with every missing-data flag off. */
const COMPLETE = {
  catalogUnavailable: false,
  catalogProvidersEmpty: false,
  providersEmpty: false,
} as const;

describe('providerDataNotice', () => {
  it('names the failed catalog first, whatever the provider rows hold', () => {
    expect(providerDataNotice({ ...COMPLETE, catalogUnavailable: true })).toBe(
      'organizationModelAccess.catalogUnavailable'
    );
    expect(
      providerDataNotice({
        ...COMPLETE,
        catalogUnavailable: true,
        catalogProvidersEmpty: true,
        providersEmpty: true,
      })
    ).toBe('organizationModelAccess.catalogUnavailable');
  });

  it('asks for the provider data when the catalog named no provider but a saved list gave rows', () => {
    // The rows are not empty, yet a saved slug is no evidence the catalog named
    // the providers a policy filter dropped, so the retry must be offered.
    expect(providerDataNotice({ ...COMPLETE, catalogProvidersEmpty: true })).toBe(
      'organizationModelAccess.providersUnavailable'
    );
  });

  it('asks for the provider data when the rows themselves are empty', () => {
    expect(providerDataNotice({ ...COMPLETE, providersEmpty: true })).toBe(
      'organizationModelAccess.providersUnavailable'
    );
  });

  it('says nothing once the catalog named a provider and the rows exist', () => {
    expect(providerDataNotice(COMPLETE)).toBeNull();
  });
});
