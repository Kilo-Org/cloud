import type { AuthVariables } from './middleware/auth.middleware';
export { WastelandDO } from './dos/Wasteland.do';
export { WastelandContainerDO } from './dos/WastelandContainer.do';
export { WastelandRegistryDO } from './dos/WastelandRegistry.do';
export { WastelandRPCEntrypoint } from './wasteland-rpc.entrypoint';
export type WastelandEnv = {
    Bindings: Env;
    Variables: AuthVariables;
};
declare const _default: ExportedHandler<Env, unknown, unknown, unknown>;
export default _default;
