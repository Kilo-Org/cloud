'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';

export default function KiloChatIndexPage() {
  const router = useRouter();
  const { data: status, isLoading } = useKiloClawStatus();

  useEffect(() => {
    if (!isLoading && !status?.status) {
      router.replace('/claw/new');
    }
  }, [isLoading, status?.status, router]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <MessagesSquare className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
        <p className="text-muted-foreground text-sm">Select a conversation or start a new one</p>
      </div>
    </div>
  );
}
