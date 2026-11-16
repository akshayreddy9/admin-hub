// Hub storage: one JSON document, kept in memory and flushed to data/hub.json,
// or to MongoDB when MONGODB_URI is set (database MONGODB_DB, default "adminhub").
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.HUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'hub.json');
const MONGO_URI = process.env.MONGODB_URI;

let db = null;
let timer = null;
let mongo = null;

function hashSecret(secret) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(String(secret), salt, 32).toString('hex');
}
function verifySecret(secret, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}
const id = (prefix) => prefix + '_' + crypto.randomBytes(6).toString('hex');
const token = () => crypto.randomBytes(24).toString('hex');

// First run: one hub admin and the apps listed in HUB_APPS (or the two local defaults).
function seed() {
  let apps;
  try { apps = JSON.parse(process.env.HUB_APPS || ''); } catch { apps = null; }
  if (!Array.isArray(apps)) {
    apps = [
      { name: 'GGPay', url: 'http://localhost:4000', color: '#1a73e8' },
      { name: 'PayTwin', url: 'http://localhost:4001', color: '#0e4aa1' },
    ];
  }
  return {
    admins: [{ id: id('hub'), username: 'admin', name: 'Hub Admin', passHash: hashSecret(process.env.HUB_ADMIN_PASSWORD || 'admin123'), role: 'super', createdAt: Date.now() }],
    sessions: {},
    apps: apps.map((a, i) => ({ id: id('app'), name: a.name, url: String(a.url).replace(/\/+$/, ''), color: a.color || '#0e4aa1', order: i + 1, appToken: '', appAdmin: '', createdAt: Date.now() })),
    log: [],
  };
}

async function load() {
  if (MONGO_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
      await client.connect();
      mongo = client.db(process.env.MONGODB_DB || 'adminhub').collection('state');
      const doc = await mongo.findOne({ _id: 'hub' });
      db = doc ? JSON.parse(doc.json) : seed();
      if (!doc) await flush();
      console.log('Storage: MongoDB');
      return db;
    } catch (e) {
      mongo = null;
      console.error('WARNING: MongoDB unreachable (' + e.message + '). Using local storage.');
    }
  }
  db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : seed();
  flush();
  console.log('Storage: ' + FILE);
  return db;
}

const get = () => db;
function save() { clearTimeout(timer); timer = setTimeout(flush, 150); }
async function flush() {
  if (mongo) {
    try { await mongo.replaceOne({ _id: 'hub' }, { _id: 'hub', json: JSON.stringify(db), savedAt: new Date() }, { upsert: true }); } catch (e) { console.error('Mongo save failed:', e.message); }
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
}
const storage = () => (mongo ? 'mongodb' : 'disk');

module.exports = { load, get, save, flush, id, token, hashSecret, verifySecret, storage };
