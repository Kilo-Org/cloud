'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function KiloChatIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/claw/chat');
  }, [router]);

  return null;
}
