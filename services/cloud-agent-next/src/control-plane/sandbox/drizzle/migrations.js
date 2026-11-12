import journal from './meta/_journal.json';
import m0000 from './0000_sandbox_control_v2.sql';
import m0001 from './0001_scope_grants.sql';
import m0002 from './0002_naive_deadpool.sql';
import m0003 from './0003_route_environment.sql';
import m0004 from './0004_young_inhumans.sql';
import m0005 from './0005_create_attempt_budget.sql';
import m0006 from './0006_third_silhouette.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
  },
};
