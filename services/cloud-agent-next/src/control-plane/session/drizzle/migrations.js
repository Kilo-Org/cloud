import journal from './meta/_journal.json';
import m0000 from './0000_open_union_jack.sql';
import m0001 from './0001_medical_thunderbolt.sql';
import m0002 from './0002_session_mutation_cursor.sql';
import m0003 from './0003_history_hydration_stage.sql';
import m0004 from './0004_native_history_scope.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
  },
};
