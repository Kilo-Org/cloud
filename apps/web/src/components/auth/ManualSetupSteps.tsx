import { Alert, AlertDescription } from '@/components/ui/alert';
import { CopyTokenButton } from './CopyTokenButton';

type ManualSetupStepsProps = {
  kiloToken: string;
  ideDescription?: string;
};

export function ManualSetupSteps({ kiloToken, ideDescription = 'Web IDE' }: ManualSetupStepsProps) {
  return (
    <>
      {/* Step 1 */}
      <div className="flex gap-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-sm font-semibold text-white">
          1
        </div>
        <div className="flex-1">
          <h3 className="mb-2 font-semibold">Copy your Kilo Code API Key</h3>
          <p className="text-muted-foreground mb-3 text-sm">
            Click the copy button to save your key to clipboard
          </p>
          <CopyTokenButton kiloToken={kiloToken} />
          <Alert variant="warning" className="mt-4">
            <AlertDescription>
              Don&rsquo;t share your API key with others or use it in other places.
            </AlertDescription>
          </Alert>
        </div>
      </div>

      {/* Step 2 */}
      <div className="flex gap-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-sm font-semibold text-white">
          2
        </div>
        <div className="flex-1">
          <h3 className="mb-2 font-semibold">Paste in Kilo Code Settings</h3>
          <p className="text-muted-foreground text-sm">
            Open your {ideDescription} settings and paste the API key
          </p>
        </div>
      </div>
    </>
  );
}
