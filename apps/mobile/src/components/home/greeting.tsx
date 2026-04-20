import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type GreetingProps = {
  title: string;
};

function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) {
    return 'morning';
  }
  if (hour < 17) {
    return 'afternoon';
  }
  return 'evening';
}

export function buildTimedGreeting(firstName: string | null): string {
  const period = timeOfDay(new Date().getHours());
  return firstName ? `Good ${period}, ${firstName}` : `Good ${period}`;
}

export function Greeting({ title }: Readonly<GreetingProps>) {
  return (
    <View className="px-4 pb-4 pt-2">
      <Text className="text-2xl font-semibold">{title}</Text>
    </View>
  );
}
