import { useQuery } from '@tanstack/react-query';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import type { StoredAuth } from '@/src/shared/auth';
import { fetchKiloGatewayModels } from '@/src/shared/kilo-api-client';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { getGatewayModelsQueryKey } from '@/src/shared/side-panel-query-options';

const apiBaseUrl = getKiloApiBaseUrl();
const emptyModelOptions: KiloGatewayModelOption[] = [];
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);

export const useGatewayModels = ({
  auth,
  organizationId,
}: {
  auth: StoredAuth;
  organizationId: string | undefined;
}): {
  readonly modelLoadError: string | undefined;
  readonly modelOptions: KiloGatewayModelOption[];
  readonly refetchModels: () => Promise<unknown>;
} => {
  const query = useQuery({
    queryFn: ({ signal }) =>
      fetchKiloGatewayModels({
        apiBaseUrl,
        fetch: fetchFromWindow,
        organizationId,
        signal,
        token: auth.token,
      }),
    queryKey: getGatewayModelsQueryKey({ organizationId, token: auth.token }),
  });

  return {
    modelLoadError: query.isError ? 'Could not load models.' : undefined,
    modelOptions: query.data ?? emptyModelOptions,
    refetchModels: query.refetch,
  };
};
