import { storage } from '#imports';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { z } from 'zod';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import type { FetchLike } from '@/src/shared/auth';
import { fetchKiloOrganizations } from '@/src/shared/kilo-api-client';
import type { KiloOrganizationOption } from '@/src/shared/kilo-api-client';
import { getSelectableOrganizationId } from '@/src/shared/organization-selection';

const selectedOrganizationStorageKey = 'local:kiloSelectedOrganizationId';
const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow: FetchLike = (input, init) => fetch(input, init);
const selectedOrganizationIdSchema = z.string();

export const useOrganizationCreditAccount = (
  token: string
): {
  organizationOptions: KiloOrganizationOption[];
  selectOrganization: (organizationId: string) => void;
  selectedOrganizationId: string;
} => {
  const [organizationOptions, setOrganizationOptions] = useState<KiloOrganizationOption[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('');
  const selectedOrganizationIdRef = useRef('');

  useEffect(() => {
    const abort = new AbortController();

    void (async (): Promise<void> => {
      try {
        const organizations = await fetchKiloOrganizations({
          apiBaseUrl,
          fetch: fetchFromWindow,
          signal: abort.signal,
          token,
        });
        const storedOrganizationId = await storage.getItem<string>(selectedOrganizationStorageKey);

        if (abort.signal.aborted) {
          return;
        }

        setOrganizationOptions(organizations);
        const parsedStoredOrganizationId =
          selectedOrganizationIdSchema.safeParse(storedOrganizationId);

        const nextOrganizationId = getSelectableOrganizationId({
          organizations,
          selectedOrganizationId: selectedOrganizationIdRef.current,
          storedOrganizationId: parsedStoredOrganizationId.success
            ? parsedStoredOrganizationId.data
            : null,
        });

        selectedOrganizationIdRef.current = nextOrganizationId;
        setSelectedOrganizationId(nextOrganizationId);

        if (nextOrganizationId === '') {
          await storage.removeItem(selectedOrganizationStorageKey);
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          setOrganizationOptions([]);
        }
      }
    })();

    return () => {
      abort.abort();
    };
  }, [token]);

  const selectOrganization = (organizationId: string): void => {
    selectedOrganizationIdRef.current = organizationId;
    setSelectedOrganizationId(organizationId);

    if (organizationId === '') {
      void storage.removeItem(selectedOrganizationStorageKey);
      return;
    }

    void storage.setItem(selectedOrganizationStorageKey, organizationId);
  };

  return { organizationOptions, selectOrganization, selectedOrganizationId };
};

export const OrganizationCreditAccountSelect = ({
  onChange,
  organizationOptions,
  selectedOrganizationId,
}: {
  onChange: (organizationId: string) => void;
  organizationOptions: KiloOrganizationOption[];
  selectedOrganizationId: string;
}): JSX.Element => (
  <label className="grid gap-1 text-xs font-medium text-zinc-500">
    Credit account
    <select
      aria-label="Credit account"
      className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
      onChange={event => {
        onChange(event.currentTarget.value);
      }}
      value={selectedOrganizationId}
    >
      <option value="">Personal</option>
      {organizationOptions.map(organization => (
        <option key={organization.id} value={organization.id}>
          {organization.name}
        </option>
      ))}
    </select>
  </label>
);
