export { isIpAddress, isPublicIp } from './ip-address';
export {
  checkUpstreamUrl,
  clearUpstreamUrlPolicyCache,
  isUpstreamUrlPolicyEnforced,
  validatedUpstreamAddresses,
  type ResolveHostAddresses,
  type UpstreamUrlVerdict,
  type UpstreamUrlViolation,
} from './upstream-url-policy';
export { upstreamDispatcher } from './upstream-connection';
