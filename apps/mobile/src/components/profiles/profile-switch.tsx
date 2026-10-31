import { type SwitchProps } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The switch a profile form row carries.
 *
 * It is the shared `Switch` plus one themed property: the off track. Android
 * paints the platform's own off track in almost the card colour on a dark
 * surface, so an off switch showed one floating thumb and did not read as a
 * switch at all. The enabled state keeps the platform accent, which is what an
 * on switch has always looked like on both platforms.
 */
export function ProfileSwitch(props: SwitchProps) {
  const colors = useThemeColors();
  return <Switch {...props} trackColor={{ false: colors.switchTrack }} />;
}
