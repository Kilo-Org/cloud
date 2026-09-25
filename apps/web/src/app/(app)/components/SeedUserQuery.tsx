'use client';

import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Seeds the query cache with the user resolved during SSR, before the app shell
 * renders.
 *
 * The sidebar's `useUser()` footer renders a skeleton while `['user']` is
 * pending, then swaps to the real footer as soon as the client query resolves.
 * When that swap lands while React is still hydrating, React sees the server's
 * skeleton HTML next to the client's footer, regenerates the whole tree and
 * drops interactions that land in between (observed as an unclickable profile
 * picker on /cloud). Seeding the same value the server rendered removes the
 * swap entirely.
 */
export function SeedUserQuery({ user }: { user: unknown }) {
  const queryClient = useQueryClient();
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    queryClient.setQueryData(['user'], user);
  }
  return null;
}
