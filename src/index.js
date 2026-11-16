// Admin Hub: one login to control every payment app (GGPay, PayTwin, future clones).
// Each app keeps its own server and database. The hub stores which apps exist and an admin
// session token for each one; the browser then talks to the chosen app's admin API directly.
const path = require('path');
const express = require('express');
const store = require('./db');

const PORT = process.env.PORT || 5000;
const D = () => store.get();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/', express.static(path.join(__dirname, '..', 'public')));
const SOCKET_JS = path.join(path.dirname(require.resolve('socket.io-client/package.json')), 'dist', 'socket.io.min.js');
app.get('/vendor/socket.io.js', (req, res) => res.sendFile(SOCKET_JS));

class HubError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const fail = (status, message, code) => { throw new HubError(status, message, code); };
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    store.save();
    res.json(out === undefined ? { ok: true } : out);
  } catch (e) {
    if (!(e instanceof HubError)) console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Server error', code: e.code });
  }
};
function auth(req) {
  const sess = D().sessions[(req.headers.authorization || '').replace('Bearer ', '')];
  const admin = sess && D().admins.find((a) => a.id === sess.adminId);
  if (!admin) fail(401, 'Please sign in', 'UNAUTHORIZED');
  return admin;
}
const route = (fn) => wrap((req, res) => fn(req, auth(req), res));
const log = (admin, text) => { D().log.unshift({ at: Date.now(), admin: admin.name, text }); D().log.length = Math.min(D().log.length, 500); };
const publicApp = ({ appToken, ...a }) => ({ ...a, connected: !!appToken });
const findApp = (req) => D().apps.find((a) => a.id === req.params.id) || fail(404, 'App not found');

// Calls an app server. Free hosts sleep, so allow a long first response.
async function callApp(a, method, p, body, tokenOverride) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 75000);
  try {
    const res = await fetch(a.url + '/api' + p, {
      method, signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (tokenOverride ?? a.appToken ?? '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    fail(502, `${a.name} is not reachable at ${a.url}. Is its server running?`, 'APP_OFFLINE');
  } finally { clearTimeout(t); }
}

// ----- hub auth -----
app.post('/hub/login', wrap((req) => {
  const a = D().admins.find((x) => x.username === String(req.body.username || '').trim());
  if (!a || !store.verifySecret(req.body.password || '', a.passHash)) fail(400, 'Wrong username or password');
  const token = store.token();
  D().sessions[token] = { adminId: a.id, at: Date.now() };
  log(a, 'Signed in to the hub');
  return { token, admin: { id: a.id, name: a.name, username: a.username, role: a.role } };
}));
app.post('/hub/logout', wrap((req) => { delete D().sessions[(req.headers.authorization || '').replace('Bearer ', '')]; }));
app.get('/hub/me', route((req, a) => ({ admin: { id: a.id, name: a.name, username: a.username, role: a.role }, storage: store.storage() })));

// ----- apps -----
app.get('/hub/apps', route(() => ({ apps: [...D().apps].sort((a, b) => a.order - b.order).map(publicApp) })));

app.post('/hub/apps', route((req, admin) => {
  const name = String(req.body.name || '').trim();
  const url = String(req.body.url || '').trim().replace(/\/+$/, '');
  if (!name) fail(400, 'Give the app a name');
  if (!/^https?:\/\//.test(url)) fail(400, 'Server URL must start with http:// or https://');
  const a = { id: store.id('app'), name, url, color: req.body.color || '#0e4aa1', order: D().apps.length + 1, appToken: '', appAdmin: '', createdAt: Date.now() };
  D().apps.push(a);
  log(admin, `Added app ${name} (${url})`);
  return { app: publicApp(a) };
}));

app.put('/hub/apps/:id', route((req, admin) => {
  const a = findApp(req);
  if (req.body.name !== undefined) a.name = String(req.body.name).trim() || a.name;
  if (req.body.color !== undefined) a.color = req.body.color;
  if (req.body.order !== undefined) a.order = Number(req.body.order) || a.order;
  if (req.body.url !== undefined) {
    const url = String(req.body.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) fail(400, 'Server URL must start with http:// or https://');
    if (url !== a.url) { a.url = url; a.appToken = ''; a.appAdmin = ''; }
  }
  log(admin, `Edited app ${a.name}`);
  return { app: publicApp(a) };
}));

app.delete('/hub/apps/:id', route((req, admin) => {
  const a = findApp(req);
  D().apps = D().apps.filter((x) => x.id !== a.id);
  log(admin, `Removed app ${a.name} from the hub (its data is untouched)`);
}));

// Health + quick stats for the overview cards (no login to the app needed for health).
app.get('/hub/apps/:id/status', route(async (req) => {
  const a = findApp(req);
  const started = Date.now();
  const health = await callApp(a, 'GET', '/health', null, '').catch((e) => ({ status: 0, error: e.message }));
  if (!health.status) return { online: false, error: health.error };
  const out = { online: health.status === 200, ms: Date.now() - started, storage: health.data.storage };
  if (a.appToken) {
    const s = await callApp(a, 'GET', '/admin/stats');
    if (s.status === 200) {
      const { users, transactions, failed, volumeToday, totalBalance, openTickets, settings } = s.data;
      out.stats = { users, transactions, failed, volumeToday, totalBalance, openTickets, maintenance: !!(settings && settings.maintenanceMode) };
    } else if (s.status === 401) { a.appToken = ''; }
  }
  return out;
}));

// Sign the hub in to an app's admin panel (the app's own admin username/password).
app.post('/hub/apps/:id/login', route(async (req, admin) => {
  const a = findApp(req);
  const r = await callApp(a, 'POST', '/admin/login', { username: req.body.username, password: req.body.password }, '');
  if (r.status !== 200) fail(400, r.data.error || `Could not sign in to ${a.name}`);
  a.appToken = r.data.token;
  a.appAdmin = r.data.admin.name;
  log(admin, `Connected the hub to ${a.name} as ${r.data.admin.username}`);
  return { url: a.url, token: a.appToken, appAdmin: a.appAdmin };
}));

// Hand the browser a working session for the app, or say a sign-in is needed.
app.post('/hub/apps/:id/connect', route(async (req, admin) => {
  const a = findApp(req);
  if (!a.appToken) return { needLogin: true };
  const r = await callApp(a, 'GET', '/admin/me');
  if (r.status === 401) { a.appToken = ''; return { needLogin: true }; }
  if (r.status !== 200) fail(502, r.data.error || `${a.name} returned an error`);
  log(admin, `Opened ${a.name}`);
  return { url: a.url, token: a.appToken, appAdmin: r.data.admin.name };
}));

app.post('/hub/apps/:id/disconnect', route((req, admin) => {
  const a = findApp(req);
  a.appToken = '';
  a.appAdmin = '';
  log(admin, `Disconnected ${a.name}`);
}));

// ----- hub admins & activity -----
app.get('/hub/admins', route(() => ({ admins: D().admins.map(({ passHash, ...x }) => x) })));
app.post('/hub/admins', route((req, admin) => {
  if (admin.role !== 'super') fail(403, 'Only the super admin can add hub admins');
  const { username, password, name } = req.body;
  if (!username || String(password || '').length < 6) fail(400, 'Username and a password of 6+ characters are required');
  if (D().admins.some((x) => x.username === username)) fail(400, 'Username already exists');
  const x = { id: store.id('hub'), username, name: name || username, passHash: store.hashSecret(password), role: 'admin', createdAt: Date.now() };
  D().admins.push(x);
  log(admin, `Added hub admin ${username}`);
  return { admin: { id: x.id, username, name: x.name, role: x.role } };
}));
app.delete('/hub/admins/:aid', route((req, admin) => {
  const x = D().admins.find((y) => y.id === req.params.aid);
  if (!x) fail(404, 'Not found');
  if (x.role === 'super' || x.id === admin.id) fail(400, 'This admin cannot be removed');
  D().admins = D().admins.filter((y) => y.id !== x.id);
  Object.keys(D().sessions).forEach((k) => { if (D().sessions[k].adminId === x.id) delete D().sessions[k]; });
  log(admin, `Removed hub admin ${x.username}`);
}));
app.post('/hub/password', route((req, admin) => {
  if (!store.verifySecret(req.body.oldPassword || '', admin.passHash)) fail(400, 'Current password is wrong');
  if (String(req.body.newPassword || '').length < 6) fail(400, 'New password must be at least 6 characters');
  admin.passHash = store.hashSecret(req.body.newPassword);
  log(admin, 'Changed hub password');
}));
app.get('/hub/log', route(() => ({ log: D().log.slice(0, 200) })));
app.get('/hub/health', (req, res) => res.json({ ok: true, storage: store.storage() }));

process.on('SIGINT', async () => { await store.flush(); process.exit(0); });
store.load().then(() => app.listen(PORT, () => {
  console.log(`\nAdmin Hub running: http://localhost:${PORT}   (admin / ${process.env.HUB_ADMIN_PASSWORD ? '••••' : 'admin123'})\n`);
}));
