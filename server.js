require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use('/static', express.static(path.join(__dirname, 'src/public')));

// Load middleware AFTER express setup (avoids top-level crash on missing dep)
const { authMiddleware, adminMiddleware } = require('./src/middleware/authMiddleware');

// ── Public pages ──────────────────────────────────────────
app.get('/',      (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'src/public/login.html')));

// ── Protected pages ───────────────────────────────────────
app.get('/dashboard', authMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, 'src/public/dashboard.html'))
);
app.get('/admin', authMiddleware, adminMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, 'src/public/admin.html'))
);

// ── API routes (auth applied HERE at router level) ────────
app.use('/api/auth',                    require('./src/routes/auth'));
app.use('/api/zoho',                    require('./src/routes/zohoWebhook'));
app.use('/api/admin',    authMiddleware, adminMiddleware, require('./src/routes/admin'));
app.use('/api/dashboard',authMiddleware, require('./src/routes/dashboard'));
app.use('/api/products', authMiddleware, require('./src/routes/products'));
app.use('/api/orders',   authMiddleware, require('./src/routes/orders'));

// ── Health (public) ───────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'GLC Dealer Portal',
  env: process.env.VERCEL ? 'vercel' : 'local',
  timestamp: new Date().toISOString(),
}));

// ── Auth diagnostic (remove after debugging) ─────────────────
app.get('/health/auth', async (req, res) => {
  const mask = (v) => v ? v.slice(0,6) + '...' + v.slice(-4) : '❌ NOT SET';
  const result = {
    env: {
      ZOHO_CLIENT_ID:     mask(process.env.ZOHO_CLIENT_ID),
      ZOHO_CLIENT_SECRET: mask(process.env.ZOHO_CLIENT_SECRET),
      ZOHO_REFRESH_TOKEN: mask(process.env.ZOHO_REFRESH_TOKEN),
      ZOHO_ORG_ID:        process.env.ZOHO_ORG_ID     || '❌ NOT SET',
      ZOHO_ACCOUNTS_URL:  process.env.ZOHO_ACCOUNTS_URL || '(default: accounts.zoho.com)',
      ZOHO_BOOKS_URL:     process.env.ZOHO_BOOKS_URL   || '(default)',
      JWT_SECRET:         process.env.JWT_SECRET       ? '✓ SET' : '❌ NOT SET',
      ADMIN_EMAIL:        process.env.ADMIN_EMAIL      || '❌ NOT SET',
    },
    token: null,
    error: null,
  };
  try {
    const { getAccessToken } = require('./src/services/zohoAuth');
    const token = await getAccessToken();
    result.token = token ? '✓ Token obtained: ' + token.slice(0,10) + '...' : '❌ Empty token';
  } catch (err) {
    result.error = err.message;
  }
  res.json(result);
});



// ── Cache management ──────────────────────────────────────
app.get('/cache/clear',  doClearCache);
app.post('/cache/clear', doClearCache);
async function doClearCache(req, res, next) {
  try {
    const { clearAllCache } = require('./src/services/zohoBooks');
    await clearAllCache();
    res.json({ success: true, message: 'Cache cleared' });
  } catch (err) {
    next(err);
  }
}

app.get('/cache/status', async (req, res) => {
  try {
    const { getCacheStatus } = require('./src/services/cacheStore');
    res.json(await getCacheStatus());
  } catch (err) {
    res.json({ cacheEntries: 0, error: err.message });
  }
});

// ── Zoho OAuth callback ───────────────────────────────────
app.get('/zoho/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code received.');
  const axios = require('axios');
  try {
    const r = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
      params: {
        code, grant_type: 'authorization_code',
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri:  `${process.env.APP_URL || `http://localhost:${PORT}`}/zoho/callback`,
      },
    });
    res.send(`<h2>✅ Success!</h2><pre style="background:#f4f4f4;padding:16px;border-radius:8px">ZOHO_REFRESH_TOKEN=${r.data.refresh_token}</pre>`);
  } catch (err) {
    res.send(`<h2>❌ Error</h2><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ GLC Dealer Portal → http://localhost:${PORT}\n`);
  });
}

module.exports = app;