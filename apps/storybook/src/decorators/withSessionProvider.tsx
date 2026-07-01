import React from 'react';
import type { Decorator } from '@storybook/nextjs';
import { SessionProvider } from 'next-auth/react';

export const withSessionProvider: Decorator = Story => {
  return (
    <SessionProvider session={null} refetchInterval={0} refetchOnWindowFocus={false}>
      <Story />
    </SessionProvider>
  );
};
