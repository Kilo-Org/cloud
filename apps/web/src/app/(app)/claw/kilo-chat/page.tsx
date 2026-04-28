'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { useKiloChatContext } from './components/kiloChatContext';

export default function KiloChatIndexPage() {
  const router = useRouter();
  const { instanceStatus, isInstanceLoading, noInstanceRedirect } = useKiloChatContext();

  useEffect(() => {
    if (!isInstanceLoading && !instanceStatus) {
      router.replace(noInstanceRedirect);
    }
  }, [isInstanceLoading, instanceStatus, noInstanceRedirect, router]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <MessagesSquare className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
        <p className="text-muted-foreground text-sm">Select a conversation or start a new one</p>
      </div>
    </div>
  );
}
