export function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-border bg-surface-inset rounded-lg border p-6">
      <div className="type-body font-medium">{title}</div>
      <p className="type-label text-muted-foreground mt-1">{description}</p>
    </div>
  );
}
