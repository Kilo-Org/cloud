import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type FlattenedZodError = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

type ErrorCardProps = {
  title: string;
  description: string;
  error: unknown;
  onRetry: () => void;
};

type TRPCError = {
  message: string;
  data?: {
    zodError?: FlattenedZodError;
  };
};

function isTRPCError(error: unknown): error is TRPCError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function formatZodErrors(zodError: FlattenedZodError | undefined): string[] {
  if (!zodError) return [];

  const errors: string[] = [];

  // Add form-level errors
  if (zodError.formErrors && zodError.formErrors.length > 0) {
    errors.push(...zodError.formErrors);
  }

  // Add field-level errors with friendly formatting
  if (zodError.fieldErrors) {
    Object.entries(zodError.fieldErrors).forEach(([field, fieldErrors]) => {
      if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
        fieldErrors.forEach((fieldError: string) => {
          // Convert field names to more readable format
          const friendlyFieldName = field
            .replace(/([A-Z])/g, ' $1') // Add space before capital letters
            .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
            .replace(/_/g, ' '); // Replace underscores with spaces

          errors.push(`${friendlyFieldName}: ${fieldError}`);
        });
      }
    });
  }

  return errors;
}

export function ErrorCard({ title, description, error, onRetry }: ErrorCardProps) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="py-8 text-center">
          <div className="mb-4 text-red-600">
            {errorMessages.length === 1 ? (
              <p>{errorMessages[0]}</p>
            ) : (
              <ul className="space-y-1 text-left">
                {errorMessages.map((message, index) => (
                  <li key={index} className="flex items-start">
                    <span className="mr-2">•</span>
                    <span>{message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button onClick={onRetry} variant="outline" size="sm">
            Try Again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
