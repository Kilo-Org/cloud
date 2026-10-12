import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as Device from 'expo-device';
import { Paths } from 'expo-file-system';

import { type DeviceBudget, maxParametersFor } from './device-fit';
import {
  hfListUrl,
  type HfModelDetail,
  type HfModelPage,
  hfRepoInfo,
  hfRepoUrl,
  hfTreeUrl,
  readModelDetail,
  readModelPage,
} from './hf-catalog';

export class HfRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Hugging Face answered ${status}`);
    this.status = status;
  }
}

async function hfGet(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new HfRequestError(response.status);
  }
  const body: unknown = await response.json();
  return { body, link: response.headers.get('link') };
}

/** Read on every render: storage changes as models download and as other apps write. */
export function deviceBudget(): DeviceBudget {
  return { memoryBytes: Device.totalMemory, freeBytes: Paths.availableDiskSpace };
}

/** A missing repository does not appear on a retry. */
const retry = (failures: number, error: Error) =>
  failures < 2 && !(error instanceof HfRequestError && error.status === 404);

export function useHfModelSearch(input: {
  readonly search: string;
  readonly fitsOnly: boolean;
  readonly memoryBytes: number | null;
}) {
  const maxParameters =
    input.fitsOnly && input.memoryBytes !== null ? maxParametersFor(input.memoryBytes) : undefined;
  const firstPage = hfListUrl({ search: input.search, maxParameters });
  return useInfiniteQuery({
    queryKey: ['hf-catalog', 'models', firstPage],
    queryFn: async ({ pageParam, signal }): Promise<HfModelPage> => {
      const { body, link } = await hfGet(pageParam, signal);
      return readModelPage(body, link);
    },
    initialPageParam: firstPage,
    getNextPageParam: page => page.next,
    retry,
  });
}

export function useHfModelDetail(id: string) {
  return useQuery({
    queryKey: ['hf-catalog', 'model', id],
    queryFn: async ({ signal }): Promise<HfModelDetail> => {
      const repo = await hfGet(hfRepoUrl(id), signal);
      const info = hfRepoInfo.parse(repo.body);
      const tree = await hfGet(hfTreeUrl(info.id, info.sha), signal);
      return readModelDetail(info, tree.body);
    },
    retry,
  });
}
