import journal from './meta/_journal.json';
import m0000 from './0000_sandbox_control_v2.sql';
import m0001 from './0001_scope_grants.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
