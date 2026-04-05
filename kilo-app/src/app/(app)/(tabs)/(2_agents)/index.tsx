import { Bot } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';

export default function AgentSessionList() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Agents" headerRight={<ProfileAvatarButton />} />
      <View className="flex-1 items-center justify-center">
        <EmptyState
          icon={Bot}
          title="No sessions yet"
          description="Your agent sessions will appear here"
        />
      </View>
    </View>
  );
}
