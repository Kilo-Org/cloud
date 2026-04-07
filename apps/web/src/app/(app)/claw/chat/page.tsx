'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ClawChatPage } from '../components/ClawChatPage';

export default function PersonalClawChatPage() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash === 'subscription') {
      router.replace('/claw/subscription');
    } else if (hash === 'changelog') {
      router.replace('/claw/changelog');
    }
  }, [router]);

  return <ClawChatPage />;
}
