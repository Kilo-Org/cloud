import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as Device from 'expo-device';
import { Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';

import { type DeviceBudget, maxParametersFor } from './device-fit';
import { useGgufModels } from './gguf-models';
import {
  hfListUrl,
  type HfModelDetail,
  type HfModelPage,
  hfRepoInfo,
  hfRepoUrl,
  hfTreeUrl,
  readModelDetail,
  readModelPage,
  smallestDownloadBytes,
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

/** Free storage is read again when a model lands, goes, or a download starts or ends. */
export function useDeviceBudget(): DeviceBudget {
  const { models, download } = useGgufModels();
  const downloading = download !== null;
  const [freeBytes, setFreeBytes] = useState(() => Paths.availableDiskSpace);
  useEffect(() => {
    setFreeBytes(Paths.availableDiskSpace);
  }, [models, downloading]);
  return { memoryBytes: Device.totalMemory, freeBytes };
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

/**
 * A list entry states only a parameter count, which can describe a draft model
 * the repository also holds, so the list judges fit by the smallest real file:
 * files too small for the stated parameters, and auxiliary weights, do not
 * count. Rows mount again as the list scrolls; the sizes stay cached meanwhile.
 */
export function useHfSmallestDownload(id: string, parameters: number | undefined) {
  return useQuery({
    queryKey: ['hf-catalog', 'smallest', id, parameters],
    queryFn: async ({ signal }): Promise<number | null> => {
      const tree = await hfGet(hfTreeUrl(id, 'main'), signal);
      return smallestDownloadBytes(tree.body, parameters) ?? null;
    },
    staleTime: 30 * 60 * 1000,
    retry,
  });
}
