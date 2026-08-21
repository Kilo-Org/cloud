import { ModelPickerContent } from '@/components/agents/model-picker-content';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function ModelPickerScreen() {
  useRouteForegroundRefresh([[['modelPreferences']]]);
  return <ModelPickerContent />;
}
