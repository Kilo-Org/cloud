'use client';
import { cn } from '@/lib/utils';
import CountUp from 'react-countup';

type AnimatedMicrodollarsProps = {
  dollars: number;
  className?: string;
};

export function AnimatedDollars({ dollars, className }: AnimatedMicrodollarsProps) {
  const colorClass = dollars < 0 ? 'text-destructive' : dollars < 2 ? 'text-yellow-500' : '';

  return (
    <CountUp
      start={0}
      end={dollars}
      duration={2}
      decimals={2}
      decimal="."
      prefix="$"
      separator=","
      preserveValue
      className={cn(className, colorClass)}
    />
  );
}
