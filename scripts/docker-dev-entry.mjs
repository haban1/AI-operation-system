import fs from 'node:fs';
import { config } from '../src/config.js';

// Initialize only a new development database. Subsequent starts preserve state.
if (!fs.existsSync(config.databasePath)) {
  const { db } = await import('../src/db.js');
  const { saveMasterSwitch } = await import('../src/services/settings.js');
  saveMasterSwitch(false, 'Docker development initialization');
  db.exec("UPDATE platforms SET desired_state='STOPPED'; UPDATE accounts SET enabled=0,login_status='DISABLED';");
  db.close();
}
