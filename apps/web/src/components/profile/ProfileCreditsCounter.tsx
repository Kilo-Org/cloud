'use client';

import { useQuery } from '@tanstack/react-query';
import { AnimatedDollars } from '@/components/organizations/AnimatedDollars';

export default function ProfileCreditsCounter() {
  const { isPending, error, data } = useQuery({
    queryKey: ['profile-balance'],
    queryFn: () => fetch('/api/profile/balance').then(res => res.json()),
  });

  if (isPending || error) {
    // To prevent layout shift, we render a placeholder
    return <span className="invisible text-3xl font-bold">$0.00</span>;
  }

  return <AnimatedDollars dollars={data.balance} className="text-foreground text-3xl font-bold" />;
}
