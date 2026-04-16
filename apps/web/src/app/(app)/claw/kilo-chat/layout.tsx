'use client';

// TODO (Task 12): Wire getToken, currentUserId, token, instances
// by investigating:
//   - apps/web/src/lib/gastown/trpc.ts (token pattern)
//   - useKiloClawStatus() hook (instance data)
//   - useUser() hook (user ID)
// Then import and use KiloChatLayout from './components/KiloChatLayout'

export default function KiloChatRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Placeholder: renders children directly without the layout wrapper.
  // Task 12 will replace this with actual KiloChatLayout integration.
  return <>{children}</>;
}
