'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/Button';
import { X, Check } from 'lucide-react';
import { envVarKeySchema } from '@/lib/user-deployments/env-vars-validation';

export type EnvVarInputValue = {
  key: string;
  value: string;
  isSecret: boolean;
};

type EnvVarInputProps = {
  value: EnvVarInputValue;
  onChange: (value: EnvVarInputValue) => void;
  onRemove: () => void;
  onSave?: () => void;
  error?: string;
  disabled?: boolean;
  showSave?: boolean;
};

export function EnvVarInput({
  value,
  onChange,
  onRemove,
  onSave,
  error,
  disabled,
  showSave = false,
}: EnvVarInputProps) {
  const handleKeyChange = (newKey: string) => {
    // Convert to uppercase automatically
    const uppercaseKey = newKey.toUpperCase();
    onChange({ ...value, key: uppercaseKey });
  };

  const handleValueChange = (newValue: string) => {
    onChange({ ...value, value: newValue });
  };

  const handleSecretChange = (isSecret: boolean) => {
    onChange({ ...value, isSecret });
  };

  // Validate key on blur
  const validateKey = () => {
    if (!value.key) return undefined;
    try {
      envVarKeySchema.parse(value.key);
      return undefined;
    } catch (err) {
      if (err && typeof err === 'object' && 'errors' in err) {
        const zodError = err as { errors: Array<{ message: string }> };
        return zodError.errors[0]?.message || 'Invalid key';
      }
      return 'Invalid key';
    }
  };

  const keyError = error || validateKey();

  return (
    <div className="space-y-2 rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Key Input */}
        <div className="space-y-2">
          <Label htmlFor={`env-key-${value.key}`}>
            Key <span className="text-red-400">*</span>
          </Label>
          <Input
            id={`env-key-${value.key}`}
            type="text"
            value={value.key}
            onChange={e => handleKeyChange(e.target.value)}
            placeholder="API_KEY"
            disabled={disabled}
            aria-invalid={!!keyError}
            className="font-mono"
            autoComplete="off"
          />
          {keyError && <p className="text-sm text-red-400">{keyError}</p>}
          <p className="text-xs text-gray-500">Uppercase letters, numbers, and underscores only</p>
        </div>

        {/* Value Input */}
        <div className="space-y-2">
          <Label htmlFor={`env-value-${value.key}`}>
            Value <span className="text-red-400">*</span>
          </Label>
          <Input
            id={`env-value-${value.key}`}
            type={value.isSecret ? 'password' : 'text'}
            value={value.value}
            onChange={e => handleValueChange(e.target.value)}
            placeholder="Enter value"
            disabled={disabled}
            className="font-mono"
            autoComplete="off"
          />
          <p className="text-xs text-gray-500">The value for this environment variable</p>
        </div>
      </div>

      {/* Secret Checkbox and Action Buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`env-secret-${value.key}`}
            checked={value.isSecret}
            onCheckedChange={handleSecretChange}
            disabled={disabled}
          />
          <Label
            htmlFor={`env-secret-${value.key}`}
            className="cursor-pointer text-sm font-normal text-gray-300"
          >
            Mark as secret (value will be masked)
          </Label>
        </div>

        <div className="flex gap-2">
          {showSave && onSave && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onSave}
              disabled={disabled || !value.key || !value.value || !!keyError}
              className="gap-1.5"
              aria-label="Save environment variable"
            >
              <Check className="size-4" />
              Save
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRemove}
            disabled={disabled}
            className="gap-1.5 text-red-400 hover:bg-red-400/10 hover:text-red-300"
            aria-label={showSave ? 'Cancel' : 'Remove environment variable'}
          >
            <X className="size-4" />
            {showSave ? 'Cancel' : 'Remove'}
          </Button>
        </div>
      </div>
    </div>
  );
}
