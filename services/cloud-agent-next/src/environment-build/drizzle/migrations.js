import journal from './meta/_journal.json';
import m0000 from './0000_environment_build.sql';
import m0001 from './0001_solid_whiplash.sql';
import m0002 from './0002_builder_provider_state.sql';
import m0003 from './0003_nervous_hairball.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
  },
};
