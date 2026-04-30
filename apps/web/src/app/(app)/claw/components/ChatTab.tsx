'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { buildKiloChatRedirect } from './chat-redirect';

export default function ChatTab({ sandboxId, basePath }: { sandboxId: string; basePath: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(buildKiloChatRedirect(basePath, sandboxId));
  }, [router, sandboxId, basePath]);
  return null;
}
