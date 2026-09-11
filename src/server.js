const express = require('express');
const path = require('path');
const fs = require('fs');
const L = require('./lib');
const T = require('./training');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { // basic hardening headers (no CSP: pages use small inline scripts)
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build'), { maxAge: '30d' })); // homepage 3D (no CDN)
// Asset version for ?v= on scripts/styles: changes whenever a public file changes, so a new page never runs a cached old script.
const PUBLIC = path.join(__dirname, '..', 'public');
const ASSET_V = require('crypto').createHash('sha1')
  .update(fs.readdirSync(PUBLIC).map(f => { const s = fs.statSync(path.join(PUBLIC, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|')).digest('hex').slice(0, 8);
fs.mkdirSync(L.UPLOAD_DIR, { recursive: true });

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(String(d).replace(' ', 'T')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const mins = m => `${Math.floor((m || 0) / 60)}h ${(m || 0) % 60}m`;

// Load the signed-in user (fresh from DB each request so deactivation/role changes apply immediately).
app.use(async (req, res, next) => {
  const c = L.parseCookies(req.headers.cookie);
  Object.assign(res.locals, {
    appName: process.env.APP_NAME || 'SkyDesk', path: req.path, query: req.query, money, fmtDate, mins, today: L.today(), v: ASSET_V,
    L: { TRAINEE_DOCS: L.TRAINEE_DOCS, TRAINEE_DOC_HELP: L.TRAINEE_DOC_HELP, docRows: L.docRows, RPTO_DOCS: L.RPTO_DOCS, RPTO_DOCS_REQUIRED: L.RPTO_DOCS_REQUIRED, MEMBER_ROLES: L.MEMBER_ROLES, ASSET_TYPES: L.ASSET_TYPES, LEAD_SOURCES: L.LEAD_SOURCES },
    flash: c.flash || null, features: { credits: T.CREDIT_PRICE > 0, partner: T.PARTNER_SHARE > 0, payments: !!L.razorpayKeyId() },
  });
  if (c.flash) res.clearCookie('flash');
  res.flash = msg => res.cookie('flash', msg, { httpOnly: true, sameSite: 'lax', maxAge: 60000 });
  const tok = L.readToken(c.sid);
  const u = tok && await L.one(`SELECT id,rpto_id,name,email,phone,role,active,dob,gender,father_name,address,avatar,signature,totp_enabled,is_pilot,license_no,license_expiry,regulator,pro_until,session_ver
    FROM users WHERE id=?`, [tok.id]);
  if (u && u.active && u.session_ver === tok.ver) {
    if (u.role === 'member' && u.rpto_id) {
      u.roles = (await L.q('SELECT role FROM members WHERE rpto_id=? AND user_id=?', [u.rpto_id, u.id])).map(r => r.role);
      u.rpto = await L.one('SELECT id,name,city,status,status_note,logo,tagline,brand_color FROM rptos WHERE id=?', [u.rpto_id]);
      u.isAdmin = u.roles.some(r => r === 'Admin' || r === 'Accountable Manager');
      u.isInstructor = u.roles.includes('Instructor');
      u.isBD = u.roles.includes('Business Development');
    }
    req.user = u;
  }
  res.locals.user = req.user || null;
  next();
});

// Uploaded files are private; only people entitled to see a file can fetch it.
async function canSee(u, name) {
  if (u.role === 'super_admin') return true;
  const td = await L.one('SELECT user_id FROM trainee_documents WHERE file=?', [name]);
  if (td) return td.user_id === u.id || (u.role === 'member' && !!await L.one('SELECT 1 x FROM applications WHERE user_id=? AND rpto_id=?', [td.user_id, u.rpto_id]));
  const rd = await L.one('SELECT rpto_id FROM rpto_documents WHERE file=?', [name]);
  if (rd) return u.role === 'member' && rd.rpto_id === u.rpto_id;
  const md = await L.one('SELECT rpto_id FROM members WHERE dgca_cert=?', [name]);
  if (md) return u.role === 'member' && md.rpto_id === u.rpto_id;
  const tr = await L.one('SELECT user_id FROM tracks WHERE file=?', [name]);
  if (tr) return tr.user_id === u.id || (u.role === 'member' && !!await L.one('SELECT 1 x FROM applications WHERE user_id=? AND rpto_id=?', [tr.user_id, u.rpto_id]));
  const ev = await L.one('SELECT r.user_id, b.rpto_id FROM test_results r JOIN tests t ON t.id=r.test_id JOIN batches b ON b.id=t.batch_id WHERE r.evidence_file=?', [name]);
  if (ev) return ev.user_id === u.id || (u.role === 'member' && ev.rpto_id === u.rpto_id);
  if (await L.one('SELECT id FROM users WHERE ? IN (avatar, signature)', [name])) return true; // trainer signatures appear on certificates
  return !!await L.one('SELECT id FROM rptos WHERE ? IN (logo, signature, stamp)', [name]); // branding appears on certificates
}
app.get('/files/:name', L.need(() => true), async (req, res) => {
  const name = path.basename(req.params.name);
  if (!(await canSee(req.user, name))) return res.status(403).send('Forbidden');
  res.sendFile(path.join(L.UPLOAD_DIR, name), err => err && !res.headersSent && res.status(404).send('Not found'));
});

// Installable app (PWA): manifest, service worker at root scope, offline fallback page.
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').json({
  name: res.locals.appName, short_name: res.locals.appName, start_url: '/login', display: 'standalone', background_color: '#0b1324', theme_color: '#1d6fe8',
  icons: [192, 512].map(s => ({ src: `/static/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })),
}));
app.get('/sw.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, '..', 'public', 'sw.js')));
app.get('/offline', (req, res) => res.render('offline'));

app.use('/', require('./routes/public'));
app.use('/flights', require('./routes/flights'));
app.use('/pilot', require('./routes/pilot'));
app.use('/super', require('./routes/super'));
app.use('/rpto', require('./routes/rpto'));
app.use('/student', require('./routes/student'));

app.use((req, res) => res.status(404).render('message', { title: 'Page not found', text: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.locals.user ??= null; // the error may come from loading the user (e.g. DB down)
  const text = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (documents max 5 MB, flight logs max 80 MB).' : 'Something went wrong. Please try again.';
  res.status(err.status || 500).render('message', { title: 'Error', text });
});

if (require.main === module) {
  const port = +process.env.PORT || 3000;
  app.listen(port, () => console.log(`${process.env.APP_NAME || 'SkyDesk'} running on http://localhost:${port}`));
}
module.exports = app;
