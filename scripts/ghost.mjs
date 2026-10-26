import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GhostStore } from '../lib/core.js';

const [action = 'status', destination] = process.argv.slice(2);
if (!['status', 'verify', 'checkpoint', 'backup'].includes(action)) {
  console.error('Usage: node scripts/ghost.mjs status|verify|checkpoint|backup [new-file]');
  process.exitCode = 1;
} else {
  const dataDir = path.resolve(process.env.GHOST_DATA_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ghost'));
  // Inspect commands never silently create a new identity when the intended data is absent.
  if (!fs.existsSync(path.join(dataDir, 'ghost.sqlite'))) {
    console.error('No Ghost database at ' + dataDir + '. Start the installed plugin once, or set GHOST_DATA_DIR.');
    process.exitCode = 1;
  } else {
    let store;
    try {
      store = new GhostStore({ dataDir });
      const value = action === 'status' ? store.status() : action === 'verify' ? store.verify()
        : action === 'checkpoint' ? store.checkpoint() : store.backup(destination);
      console.log(JSON.stringify(value, null, 2));
      if (value.ok === false || value.health?.ok === false) process.exitCode = 2;
    } catch (error) {
      console.error(`${error.code || 'ERROR'}: ${error.message}`);
      process.exitCode = 1;
    } finally { store?.close(); }
  }
}
