'use client';

import { forwardRef, useImperativeHandle, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type WeatherLocationSource = 'browser' | 'text' | 'skip';

export type WeatherLocationSelection = {
  location: string;
  source: Exclude<WeatherLocationSource, 'skip'>;
};

export type WeatherLocationCommitResult =
  | { ok: true; selection: WeatherLocationSelection | null }
  | { ok: false };

export type WeatherLocationInputHandle = {
  commitPendingLocation: () => Promise<WeatherLocationCommitResult>;
};

type WeatherLocationInputProps = {
  disabled?: boolean;
  label?: string;
  onSelectionChange: (selection: WeatherLocationSelection | null) => void;
};

export const WeatherLocationInput = forwardRef<
  WeatherLocationInputHandle,
  WeatherLocationInputProps
>(function WeatherLocationInput(
  { disabled = false, label = 'Your Location', onSelectionChange }: WeatherLocationInputProps,
  ref
) {
  const trpc = useTRPC();
  const validateLocation = useMutation(trpc.kiloclaw.validateWeatherLocation.mutationOptions());
  const [locationInput, setLocationInput] = useState('');
  const [locationFeedback, setLocationFeedback] = useState<{
    message: string;
    status: 'validated' | 'service_unavailable';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const inputPending = disabled || validateLocation.isPending || isLocating;

  function clearSelection() {
    setLocationFeedback(null);
    onSelectionChange(null);
  }

  function showError(message: string) {
    setError(message);
    clearSelection();
    toast.error(message);
  }

  async function validateLocationInput(
    location: string,
    source: 'browser' | 'text'
  ): Promise<WeatherLocationSelection | null> {
    try {
      const result = await validateLocation.mutateAsync({ location });
      const selection = { location: result.location, source } satisfies WeatherLocationSelection;
      setLocationInput(result.location);
      setLocationFeedback({ message: result.currentWeatherText, status: result.status });
      setError(null);
      onSelectionChange(selection);
      return selection;
    } catch (caughtError) {
      showError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Weather location could not be validated. Please try again or skip weather setup.'
      );
      return null;
    }
  }

  useImperativeHandle(ref, () => ({
    async commitPendingLocation() {
      const location = locationInput.trim();
      if (!location) {
        clearSelection();
        return { ok: true, selection: null };
      }

      const selection = await validateLocationInput(location, 'text');
      return selection ? { ok: true, selection } : { ok: false };
    },
  }));

  async function handleUseBrowserLocation() {
    setError(null);

    if (!('geolocation' in navigator)) {
      showError('Browser location is unavailable. Enter a location or skip weather setup.');
      return;
    }

    setIsLocating(true);
    let position: GeolocationPosition;
    try {
      position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          maximumAge: 5 * 60_000,
          timeout: 10_000,
        });
      });
    } catch (caughtError) {
      const code =
        typeof caughtError === 'object' && caughtError !== null && 'code' in caughtError
          ? caughtError.code
          : null;
      if (code === 1) {
        showError('Browser location was denied. Enter a location or skip weather setup.');
      } else if (code === 3) {
        showError('Browser location timed out. Enter a location or skip weather setup.');
      } else {
        showError('Browser location is unavailable. Enter a location or skip weather setup.');
      }
      return;
    } finally {
      setIsLocating(false);
    }

    const coordinates = `${position.coords.latitude.toFixed(4)},${position.coords.longitude.toFixed(4)}`;
    await validateLocationInput(coordinates, 'browser');
  }

  async function handleSubmitTextLocation() {
    const location = locationInput.trim();
    setError(null);
    if (!location) {
      showError('Enter a location or skip weather setup.');
      return;
    }
    await validateLocationInput(location, 'text');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleSubmitTextLocation();
  }

  return (
    <section className="space-y-3">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
        {label}
      </h3>
      <div className="relative">
        <form onSubmit={handleSubmit}>
          <div className="border-input bg-input/30 focus-within:border-ring focus-within:ring-ring/50 flex rounded-md border shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]">
            <Input
              value={locationInput}
              onChange={event => {
                setLocationInput(event.target.value);
                setError(null);
                clearSelection();
              }}
              className="h-11 flex-1 border-0 bg-transparent shadow-none focus-visible:border-transparent focus-visible:ring-0"
              placeholder="Amsterdam, The Netherlands"
              disabled={inputPending}
              maxLength={200}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              aria-label="Weather location"
            />
            <Button
              type="button"
              variant="outline"
              className="border-brand-primary/50 bg-brand-primary/10 text-brand-primary hover:border-brand-primary/70 hover:bg-brand-primary/15 hover:text-brand-primary focus-visible:ring-brand-primary/60 m-1 h-9 shrink-0 px-3 shadow-none"
              disabled={inputPending}
              onClick={() => void handleUseBrowserLocation()}
              aria-label="Use browser location"
              title="Use browser location"
            >
              {isLocating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MapPin className="h-4 w-4" />
              )}
              Use my location
            </Button>
          </div>
        </form>

        {locationFeedback ? (
          <p
            className={cn(
              'animate-in fade-in slide-in-from-top-1 pointer-events-none absolute top-full right-0 left-0 z-10 mt-1.5 px-1 text-sm duration-300',
              locationFeedback.status === 'service_unavailable'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground'
            )}
          >
            {locationFeedback.message}
          </p>
        ) : null}
        {error ? <p className="mt-1.5 px-1 text-sm text-red-600">{error}</p> : null}
      </div>
    </section>
  );
});

WeatherLocationInput.displayName = 'WeatherLocationInput';
