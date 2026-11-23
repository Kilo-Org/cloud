import { ArrowRight, CircleCheck, CircleX, ShieldCheck, Terminal } from 'lucide-react';

export function NetworkSecretFlow() {
  return (
    <figure className="@container rounded-lg border p-3 text-xs">
      <figcaption className="sr-only">
        The sandbox sends a placeholder. The Kilo network proxy replaces it in the outgoing request
        only if it is valid and the destination domain is allowed. Otherwise, the proxy blocks the
        request.
      </figcaption>
      <div aria-hidden="true" className="flex flex-col gap-2 @lg:flex-row @lg:items-center">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <Terminal className="text-muted-foreground size-3.5 shrink-0" />
            Sandbox
          </div>
          <p className="text-muted-foreground">
            <code className="font-mono">$KEY</code> holds a placeholder
          </p>
        </div>
        <ArrowRight className="text-muted-foreground ml-0.5 size-3.5 shrink-0 rotate-90 @lg:ml-0 @lg:rotate-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <ShieldCheck className="text-muted-foreground size-3.5 shrink-0" />
            Kilo network proxy
          </div>
          <p className="text-muted-foreground">Checks the placeholder and the destination domain</p>
        </div>
        <ArrowRight className="text-muted-foreground ml-0.5 size-3.5 shrink-0 rotate-90 @lg:ml-0 @lg:rotate-0" />
        <ul className="flex-[1.5] space-y-1.5 border-l pl-2">
          <li className="flex items-start gap-1.5">
            <CircleCheck className="text-status-success size-3.5 shrink-0" />
            <span>
              <span className="text-status-success font-medium">Valid and allowed:</span> Replace
              the placeholder in the outgoing request
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <CircleX className="text-destructive size-3.5 shrink-0" />
            <span>
              <span className="text-destructive font-medium">Blocked</span> otherwise
            </span>
          </li>
        </ul>
      </div>
    </figure>
  );
}
