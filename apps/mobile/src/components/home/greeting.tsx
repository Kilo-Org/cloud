import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type GreetingProps = {
  title: string;
  eyebrow?: string;
  subtitle?: string;
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

export function Greeting({ title, eyebrow, subtitle }: Readonly<GreetingProps>) {
  return (
    <View className="px-4 pb-5 pt-2">
      {eyebrow ? <Text variant="eyebrow">{eyebrow}</Text> : null}
      <Text className="mt-1 text-[34px] font-bold tracking-tight leading-[38px] text-foreground">
        {title}
        {subtitle ? (
          <Text className="text-[34px] font-bold tracking-tight leading-[38px] text-muted-foreground">
            {` ${subtitle}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}
