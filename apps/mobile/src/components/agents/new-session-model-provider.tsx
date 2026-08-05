import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type AgentMode } from '@/components/agents/mode-selector';
import { resolvePrefillModel } from '@/components/agents/new-session-prefill';
import { useNewSessionPrefill } from '@/components/agents/use-new-session-prefill';
import { RemoteSpawnInheritanceProvider } from '@/components/agents/use-remote-spawn-dispatch';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';

export type NewSessionModelState = {
  mode: AgentMode;
  setMode: Dispatch<SetStateAction<AgentMode>>;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  variant: string;
  setVariant: Dispatch<SetStateAction<string>>;
};

type NewSessionModelProviderProps = {
  organizationId: string | undefined;
  children: ReactNode;
};

const NewSessionModelContext = createContext<NewSessionModelState | null>(null);

export function useNewSessionModelState(): NewSessionModelState {
  const state = useContext(NewSessionModelContext);
  if (state === null) {
    throw new Error('useNewSessionModelState must be used within NewSessionModelProvider');
  }
  return state;
}

export function NewSessionModelProvider({
  organizationId,
  children,
}: Readonly<NewSessionModelProviderProps>) {
  const prefill = useNewSessionPrefill();
  const [mode, setMode] = useState<AgentMode>(prefill.mode);
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const { models } = useAvailableModels(organizationId);
  const autoSelected = useAutoSelectModel(models, organizationId);
  const hasAppliedAutoSelection = useRef(false);
  const initialSelection = resolvePrefillModel(models, prefill) ?? autoSelected;
  if (!hasAppliedAutoSelection.current && initialSelection.model && !model) {
    hasAppliedAutoSelection.current = true;
    setModel(initialSelection.model);
    setVariant(initialSelection.variant);
  }
  const state = useMemo(
    () => ({ mode, setMode, model, setModel, variant, setVariant }),
    [mode, model, variant]
  );

  return (
    <RemoteSpawnInheritanceProvider mode={mode} model={model} variant={variant}>
      <NewSessionModelContext.Provider value={state}>{children}</NewSessionModelContext.Provider>
    </RemoteSpawnInheritanceProvider>
  );
}
