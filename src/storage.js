import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'lux-data.json');

const defaults = {
  channelJid: null,
  groups: {},
  forms: [],
  members: {},
  points: {},
  workLog: [],
  createdAt: new Date().toISOString()
};

export function loadDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaults, null, 2));
  try {
    return { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    const backup = `${DB_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(DB_FILE, backup);
    fs.writeFileSync(DB_FILE, JSON.stringify(defaults, null, 2));
    return structuredClone(defaults);
  }
}

let db = loadDB();
export function getDB() { return db; }
export function saveDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}
export function updateDB(fn) {
  fn(db);
  saveDB();
  return db;
}
