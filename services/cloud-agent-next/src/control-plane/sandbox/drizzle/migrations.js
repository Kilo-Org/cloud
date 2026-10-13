import journal from './meta/_journal.json';
import m0000 from './0000_sandbox_control_v2.sql';
import m0001 from './0001_scope_grants.sql';
import m0002 from './0002_naive_deadpool.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
