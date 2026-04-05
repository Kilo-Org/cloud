/**
 * Mock Date.now() and Date constructor to return a fixed timestamp
 * for consistent Storybook/Chromatic screenshots.
 *
 * This ensures all date calculations produce the same results regardless
 * of when the stories are rendered.
 */

// January 15, 2024 at 10:00:00 UTC
const FIXED_DATE = new Date('2024-01-15T10:00:00.000Z').getTime();

// Override Date.now() globally
Date.now = () => FIXED_DATE;

// Override Date constructor to return fixed date when called without arguments
const OriginalDate = globalThis.Date;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Date = class extends OriginalDate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    if (args.length === 0) {
      super(FIXED_DATE);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...(args as [any]));
    }
  }

  static override now() {
    return FIXED_DATE;
  }
};

// Preserve all other Date static methods
Object.setPrototypeOf(globalThis.Date, OriginalDate);
Object.getOwnPropertyNames(OriginalDate).forEach(key => {
  if (key !== 'now' && key !== 'length' && key !== 'prototype' && key !== 'name') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.Date as any)[key] = (OriginalDate as any)[key];
  }
});
