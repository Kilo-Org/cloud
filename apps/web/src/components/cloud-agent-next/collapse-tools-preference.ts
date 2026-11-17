import { useLocalStorage } from '@/hooks/useLocalStorage';

export const COLLAPSE_TOOLS_STORAGE_KEY = 'cloud-agent:collapse-tools';

export function useCollapseToolsPreference() {
  const [collapseTools, setCollapseTools] = useLocalStorage<boolean>(
    COLLAPSE_TOOLS_STORAGE_KEY,
    false,
    { initializeWithValue: false, deserializer: raw => raw === 'true' }
  );

  return { collapseTools, setCollapseTools };
}
