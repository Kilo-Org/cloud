'use client';

import { useId, useState } from 'react';
import { Globe } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS,
  OrganizationBrowserAllowedOriginSchema,
  OrganizationBrowserControlSchema,
  normalizeOrganizationBrowserOrigin,
  type OrganizationBrowserControl,
} from '@kilocode/db/schema-types';
import {
  useOrganizationWithMembers,
  useUpdateOrganizationBrowserControl,
} from '@/app/api/organizations/hooks';

type ControlOption = {
  value: OrganizationBrowserControl;
  label: string;
  description: string;
};

const CONTROL_OPTIONS: readonly ControlOption[] = [
  {
    value: 'allow',
    label: 'Allow',
    description:
      'Members choose between the bundled browser and their own browser through the Kilo browser extension.',
  },
  {
    value: 'playwright_only',
    label: 'Bundled browser only',
    description:
      'Members can drive the bundled browser, but their own browsers through the Kilo browser extension are refused.',
  },
  {
    value: 'off',
    label: 'Off',
    description: "Browser tools are removed from every member's Kilo client.",
  },
];

type ParsedOrigins = { origins: string[] } | { error: string };

function parseOriginLines(text: string): ParsedOrigins {
  const entries = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const invalid = entries.filter(
    entry => !OrganizationBrowserAllowedOriginSchema.safeParse(entry).success
  );
  if (invalid.length > 0) {
    return { error: `Not an http or https origin: ${invalid.join(', ')}` };
  }

  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = normalizeOrganizationBrowserOrigin(entry);
    if (origin !== null) {
      origins.add(origin);
    }
  }
  if (origins.size > MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS) {
    return {
      error: `At most ${MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS} origins can be allowed.`,
    };
  }

  return { origins: [...origins] };
}

type FormProps = {
  organizationId: string;
  savedControl: OrganizationBrowserControl;
  savedOrigins: readonly string[];
  readonly: boolean;
};

function BrowserControlForm({ organizationId, savedControl, savedOrigins, readonly }: FormProps) {
  const id = useId();
  const update = useUpdateOrganizationBrowserControl();
  const [draftControl, setDraftControl] = useState<OrganizationBrowserControl | null>(null);
  const [draftOrigins, setDraftOrigins] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const control = draftControl ?? savedControl;
  const originsText = draftOrigins ?? savedOrigins.join('\n');
  const dirty = control !== savedControl || originsText !== savedOrigins.join('\n');
  const selected = CONTROL_OPTIONS.find(option => option.value === control) ?? CONTROL_OPTIONS[0];

  const save = () => {
    const parsed = parseOriginLines(originsText);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    update.mutate(
      {
        organizationId,
        browserControl: control,
        browserAllowedOrigins: parsed.origins,
      },
      {
        onSuccess: () => {
          setDraftControl(null);
          setDraftOrigins(null);
        },
        onError: mutationError => setError(mutationError.message),
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-5" aria-hidden />
          Browser control
        </CardTitle>
        <CardDescription>
          What every member&apos;s Kilo client applies when an agent drives a browser. Origins
          listed here are granted for reading, acting, and navigating without asking the member.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-sm space-y-2">
          <Label htmlFor={`${id}-control`}>Browser access</Label>
          <Select
            value={control}
            disabled={readonly || update.isPending}
            onValueChange={value => {
              setDraftControl(OrganizationBrowserControlSchema.parse(value));
              update.reset();
            }}
          >
            <SelectTrigger
              id={`${id}-control`}
              aria-describedby={`${id}-control-help`}
              className="min-h-11 w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTROL_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value} className="min-h-11">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={`${id}-control-help`} className="text-muted-foreground text-sm">
            {selected.description}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-origins`}>Allowed origins</Label>
          <Textarea
            id={`${id}-origins`}
            value={originsText}
            readOnly={readonly || update.isPending}
            rows={3}
            placeholder={'https://example.com\nhttps://app.example.com:8443'}
            aria-describedby={`${id}-origins-help`}
            onChange={event => setDraftOrigins(event.target.value)}
          />
          <p id={`${id}-origins-help`} className="text-muted-foreground text-sm">
            One origin per line, with no path or query. Save to apply the list to every member.
          </p>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Browser control was not saved</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {readonly ? (
          <p className="text-muted-foreground text-sm">
            Only organization owners and admins can change browser control.
          </p>
        ) : (
          <Button
            type="button"
            className="min-h-11"
            disabled={!dirty || update.isPending}
            onClick={save}
          >
            {update.isPending ? 'Saving…' : 'Save browser control'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

type Props = {
  organizationId: string;
  readonly?: boolean;
};

export function OrganizationBrowserControlCard({ organizationId, readonly = false }: Props) {
  const { data } = useOrganizationWithMembers(organizationId);
  if (!data) {
    return null;
  }

  return (
    <BrowserControlForm
      organizationId={organizationId}
      savedControl={data.settings?.browserControl ?? 'allow'}
      savedOrigins={data.settings?.browserAllowedOrigins ?? []}
      readonly={readonly}
    />
  );
}
