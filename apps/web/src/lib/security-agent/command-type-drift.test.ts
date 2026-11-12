import type { SecurityCommandType } from '@kilocode/app-shared/security-agent';
import type { SecurityAgentCommandType } from '@kilocode/db/schema';

// Compile-time assertion: the db command-type union and the shared tuple must
// stay identical. A tuple edit without a matching db edit (or vice versa) fails
// typecheck here.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _CommandTypesMatch = Expect<Equal<SecurityAgentCommandType, SecurityCommandType>>;
