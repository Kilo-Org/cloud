'use client';

import { useState } from 'react';
import type { AlertingBaseline, BaselineState } from '@/app/admin/alerting/types';

export function useBaselineState() {
  const [baselineByModel, setBaselineByModel] = useState<Record<string, AlertingBaseline | null>>(
    {}
  );
  const [baselineStatus, setBaselineStatus] = useState<Record<string, BaselineState>>({});

  const setLoading = (modelId: string) => {
    setBaselineStatus(prev => ({
      ...prev,
      [modelId]: { status: 'loading' },
    }));
  };

  const setBaseline = (modelId: string, baseline: AlertingBaseline | null) => {
    setBaselineByModel(prev => ({
      ...prev,
      [modelId]: baseline,
    }));
    setBaselineStatus(prev => ({
      ...prev,
      [modelId]: { status: 'idle' },
    }));
  };

  const setError = (modelId: string, message: string) => {
    setBaselineStatus(prev => ({
      ...prev,
      [modelId]: { status: 'error', message },
    }));
  };

  return {
    baselineByModel,
    baselineStatus,
    setLoading,
    setBaseline,
    setError,
  };
}
