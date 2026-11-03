export function FieldMessages({
  description,
  descriptionId,
  error,
  errorId,
}: {
  description?: string;
  descriptionId?: string;
  error: string | undefined;
  errorId?: string;
}) {
  return (
    <>
      {description && (
        <p id={descriptionId} className="text-muted-foreground text-sm">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-destructive text-sm">
          {error}
        </p>
      )}
    </>
  );
}
