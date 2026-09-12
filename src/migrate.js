import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (await fs.readdir(path.join(root, 'migrations'))).filter((x) => x.endsWith('.sql')).sort();
try { for (const file of files) { await pool.query(await fs.readFile(path.join(root, 'migrations', file), 'utf8')); console.log(`Applied ${file}`); } } finally { await pool.end(); }
