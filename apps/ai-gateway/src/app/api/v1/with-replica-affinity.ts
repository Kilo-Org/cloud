import { bareIpLiteral, rawClientIp } from '@kilocode/web-shared/lib/bouncer/inference';
import { runWithReplicaAffinity } from '@kilocode/web-shared/lib/read-replica-affinity';

export function withReplicaAffinity<Req extends Request, Args extends unknown[], Result>(
  handler: (request: Req, ...args: Args) => Result
): (request: Req, ...args: Args) => Result {
  return (request, ...args) =>
    runWithReplicaAffinity(bareIpLiteral(rawClientIp(request)), () => handler(request, ...args));
}
