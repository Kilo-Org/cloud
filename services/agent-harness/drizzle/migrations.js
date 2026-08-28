import journal from './meta/_journal.json';
import m0000 from './0000_authoritative_store.sql';
import m0001 from './0001_projection_work.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
