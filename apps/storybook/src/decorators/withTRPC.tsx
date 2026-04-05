import React from 'react';
import type { Decorator } from '@storybook/nextjs';
import { TRPCContext } from '@/lib/trpc/client';

export const withTRPC: Decorator = Story => {
  return (
    <TRPCContext>
      <Story />
    </TRPCContext>
  );
};
