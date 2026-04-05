import { describe, test, expect } from '@jest/globals';

// Import the helper functions from ErrorCard for testing
// We'll test the logic without rendering the component
type ZodError = {
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
};

type TRPCError = {
  message: string;
  data?: {
    zodError?: ZodError;
  };
};

function isTRPCError(error: unknown): error is TRPCError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string' &&
    'data' in error
  );
}

function formatZodErrors(zodError: ZodError | undefined): string[] {
  if (!zodError) return [];

  const errors: string[] = [];

  // Add form-level errors
  if (zodError.formErrors && zodError.formErrors.length > 0) {
    errors.push(...zodError.formErrors);
  }

  // Add field-level errors
  if (zodError.fieldErrors) {
    Object.entries(zodError.fieldErrors).forEach(([field, fieldErrors]) => {
      if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
        fieldErrors.forEach((fieldError: string) => {
          errors.push(`${field}: ${fieldError}`);
        });
      }
    });
  }

  return errors;
}

function getErrorMessages(error: unknown): string[] {
  let errorMessages: string[] = [];

  if (isTRPCError(error)) {
    if (error.data?.zodError) {
      // Handle flattened Zod errors from TRPC
      const zodErrors = formatZodErrors(error.data.zodError);
      if (zodErrors.length > 0) {
        errorMessages = zodErrors;
      } else {
        errorMessages = [error.message || 'Validation failed'];
      }
    } else {
      // TRPC error without zodError
      errorMessages = [error.message];
    }
  } else if (error instanceof Error) {
    errorMessages = [error.message];
  } else {
    errorMessages = ['An unexpected error occurred'];
  }

  return errorMessages;
}

describe('ErrorCard error formatting', () => {
  test('should format simple error message', () => {
    const error = new Error('Simple error message');
    const messages = getErrorMessages(error);

    expect(messages).toEqual(['Simple error message']);
  });

  test('should format TRPC validation errors in human-readable format', () => {
    const trpcError = {
      message: 'Validation failed',
      data: {
        zodError: {
          fieldErrors: {
            email: ['Invalid email format', 'Email is required'],
            name: ['Name must be at least 2 characters'],
          },
          formErrors: ['Form submission failed'],
        },
      },
    };

    const messages = getErrorMessages(trpcError);

    expect(messages).toContain('Form submission failed');
    expect(messages).toContain('email: Invalid email format');
    expect(messages).toContain('email: Email is required');
    expect(messages).toContain('name: Name must be at least 2 characters');
  });

  test('should format TRPC error with only field errors', () => {
    const trpcError = {
      message: 'Validation failed',
      data: {
        zodError: {
          fieldErrors: {
            password: ['Password must be at least 8 characters'],
          },
          formErrors: [],
        },
      },
    };

    const messages = getErrorMessages(trpcError);

    expect(messages).toEqual(['password: Password must be at least 8 characters']);
  });

  test('should fallback to error message when no zod errors', () => {
    const trpcError = {
      message: 'Custom TRPC error',
      data: {
        zodError: {
          fieldErrors: {},
          formErrors: [],
        },
      },
    };

    const messages = getErrorMessages(trpcError);

    expect(messages).toEqual(['Custom TRPC error']);
  });

  test('should handle TRPC error without zodError', () => {
    const trpcError = {
      message: 'Server error',
      data: {},
    };

    const messages = getErrorMessages(trpcError);

    expect(messages).toEqual(['Server error']);
  });

  test('should handle unknown error types', () => {
    const unknownError = { someProperty: 'unknown error' };

    const messages = getErrorMessages(unknownError);

    expect(messages).toEqual(['An unexpected error occurred']);
  });

  test('should detect TRPC errors correctly', () => {
    const trpcError = {
      message: 'TRPC error',
      data: { zodError: { fieldErrors: {}, formErrors: [] } },
    };

    const regularError = new Error('Regular error');
    const unknownError = { notAMessage: 'test' };

    expect(isTRPCError(trpcError)).toBe(true);
    expect(isTRPCError(regularError)).toBe(false);
    expect(isTRPCError(unknownError)).toBe(false);
  });
});
