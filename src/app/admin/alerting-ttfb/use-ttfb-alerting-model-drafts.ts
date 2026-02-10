'use client';

import { useEffect, useState } from 'react';
import type { TtfbAlertingDraft } from '@/app/admin/alerting-ttfb/types';
import {
  DEFAULT_TTFB_THRESHOLD_MS,
  DEFAULT_MIN_REQUESTS,
  DEFAULT_TTFB_SLO,
} from '@/app/admin/alerting-ttfb/utils';

type TtfbAlertingConfigItem = {
  model: string;
  enabled: boolean;
  ttfbThresholdMs: number;
  ttfbSlo: number;
  minRequestsPerWindow: number;
};

type UseTtfbAlertingModelDraftsParams = {
  configs: TtfbAlertingConfigItem[] | null | undefined;
};

export function useTtfbAlertingModelDrafts({ configs }: UseTtfbAlertingModelDraftsParams) {
  const [drafts, setDrafts] = useState<Record<string, TtfbAlertingDraft>>({});

  useEffect(() => {
    if (!configs) return;

    setDrafts(prev => {
      const next = { ...prev };
      for (const config of configs) {
        if (next[config.model]) continue;
        next[config.model] = {
          enabled: config.enabled,
          ttfbThresholdMs: String(config.ttfbThresholdMs),
          ttfbSlo: String(config.ttfbSlo),
          minRequestsPerWindow: String(config.minRequestsPerWindow),
        };
      }
      return next;
    });
  }, [configs]);

  const updateDraft = (modelId: string, partial: Partial<TtfbAlertingDraft>) => {
    setDrafts(prev => {
      const existing = prev[modelId];
      if (!existing) return prev;
      return {
        ...prev,
        [modelId]: {
          ...existing,
          ...partial,
        },
      };
    });
  };

  const addDraft = (modelId: string) => {
    setDrafts(prev => ({
      ...prev,
      [modelId]: {
        enabled: false,
        ttfbThresholdMs: DEFAULT_TTFB_THRESHOLD_MS,
        ttfbSlo: DEFAULT_TTFB_SLO,
        minRequestsPerWindow: DEFAULT_MIN_REQUESTS,
      },
    }));
  };

  const removeDraft = (modelId: string) => {
    setDrafts(prev => {
      if (!prev[modelId]) return prev;
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
  };

  return {
    drafts,
    updateDraft,
    addDraft,
    removeDraft,
  };
}
