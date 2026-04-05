import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function RadioButtonGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map(option => (
        <Button
          key={option.value}
          variant={value === option.value ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 flex-1 px-3 py-1 text-xs',
            value === option.value
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow'
              : 'hover:bg-accent hover:text-accent-foreground'
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
