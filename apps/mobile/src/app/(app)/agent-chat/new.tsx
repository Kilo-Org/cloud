import { useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { type AgentMode } from '@/components/agents/mode-selector';
import { RemoteSpawnInheritanceProvider } from '@/components/agents/use-remote-spawn-dispatch';
import { resolvePrefillModel } from '@/components/agents/new-session-prefill';
import { useNewSessionPrefill } from '@/components/agents/use-new-session-prefill';
import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';

/**
 * Outer shell owns picker state and the inheritance Provider so
 * `useNewSessionShareRemote` → `useRemoteSpawnDispatch` (in the inner
 * body) reads mode/model/variant as a true descendant. Provider wrapping
 * only the returned JSX left the hook outside the tree with `{}`.
 *
 * Auto-select also lives here: `setModel`/`setVariant` belong to this
 * component, so the render-phase apply is a same-component update (legal).
 * Doing it in the body after the M1 split was a cross-component setState.
 */
export default function NewSessionScreen() {
  const prefill = useNewSessionPrefill();
  const [mode, setMode] = useState<AgentMode>(prefill.mode);
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const { organizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  // Same query key as the body — React Query dedupes; used only so
  // auto-select can run in the state owner without a cross-component update.
  const { models } = useAvailableModels(organizationId);
  const autoSelected = useAutoSelectModel(models, organizationId);
  const hasAppliedAutoSelection = useRef(false);
  const initialSelection = resolvePrefillModel(models, prefill) ?? autoSelected;
  if (!hasAppliedAutoSelection.current && initialSelection.model && !model) {
    hasAppliedAutoSelection.current = true;
    setModel(initialSelection.model);
    setVariant(initialSelection.variant);
  }

  return (
    <RemoteSpawnInheritanceProvider mode={mode} model={model} variant={variant}>
      <NewSessionScreenBody
        mode={mode}
        setMode={setMode}
        model={model}
        setModel={setModel}
        variant={variant}
        setVariant={setVariant}
      />
    </RemoteSpawnInheritanceProvider>
  );
}
