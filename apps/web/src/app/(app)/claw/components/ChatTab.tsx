'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function ChatTab({ sandboxId }: { sandboxId: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/claw/kilo-chat?sandboxId=${sandboxId}`);
  }, [router, sandboxId]);
  return null;
}
