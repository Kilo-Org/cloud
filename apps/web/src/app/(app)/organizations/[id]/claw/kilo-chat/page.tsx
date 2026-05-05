'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function OrgLegacyKiloChatIndexPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/organizations/${params.id}/claw/chat`);
  }, [params.id, router]);

  return null;
}
