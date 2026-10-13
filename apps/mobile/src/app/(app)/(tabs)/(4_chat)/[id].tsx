import { useLocalSearchParams } from 'expo-router';

import { ChatScreen } from '@/components/chat/chat-screen';

export default function ChatConversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatScreen opened={id} />;
}
