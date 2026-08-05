import { View } from 'react-native';

import { Text } from '@/components/ui/text';

import { formatTranscriptMarkerLabel } from './message-time-label';

/**
 * Centered, muted time marker that opens a run of messages. Same type treatment as
 * `CompactionSeparator`, without its hairlines: a marker recurs through the
 * transcript, so the rules would read as noise.
 */
export function TranscriptTimeMarker({
  created,
  dayChanged,
}: Readonly<{ created: number; dayChanged: boolean }>) {
  // Date.now() at render time only, exactly as the message label did: no timer and
  // no day-boundary watcher, so a marker mounted across midnight keeps its text
  // until the next render.
  const label = formatTranscriptMarkerLabel(created, Date.now(), dayChanged);
  if (label === null) {
    return null;
  }
  return (
    <View className="items-center py-2">
      <Text className="font-mono-medium text-[11px] uppercase tracking-[1px] text-muted-foreground">
        {label}
      </Text>
    </View>
  );
}
