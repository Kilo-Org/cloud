import journal from './meta/_journal.json';
import m0000 from './0000_environment_build.sql';
import m0001 from './0001_solid_whiplash.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
