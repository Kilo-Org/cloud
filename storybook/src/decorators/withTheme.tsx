import React from 'react';
import type { Decorator } from '@storybook/nextjs';

export const withTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme || 'dark';

  return (
    <div className={`storybook-component ${theme}`} data-theme={theme}>
      <Story />
    </div>
  );
};
