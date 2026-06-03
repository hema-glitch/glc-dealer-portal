require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');

const { authMiddleware, adminMiddleware } = require('./src/middleware/authMiddleware');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use('/static', express.static(path.join(__dirname, 'src/public')));

// ── Public pages ──────────────────────────────────────────
app.get('/',      (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'src/public/login.html')));

// ── Protected pages (auth required) ──────────────────────
app.get('/dashboard', authMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, 'src/public/dashboard.html'))
);
app.get('/admin', authMiddleware, adminMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, 'src/public/admin.html'))
);

// ── API routes ────────────────────────────────────────────
app.use('/api/auth',      require('./src/routes/auth'));
app.use('/api/admin',     require('./src/routes/admin'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/products',  require('./src/routes/products'));
app.use('/api/orders',    require('./src/routes/orders'));

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', service: 'GLC Dealer Portal',
  env: process.env.VERCEL ? 'vercel' : 'local',
  timestamp: new Date().toISOString(),
}));

// ── Cache management ──────────────────────────────────────
app.get('/cache/status', (req, res) => {
  const fs   = require('fs');
  const file = process.env.VERCEL ? '/tmp/.glc-cache.json' : path.join(__dirname, '.cache.json');
  try {
    const store   = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now     = Date.now();
    const entries = Object.entries(store).map(([key, entry]) => ({
      key,
      expiresIn: Math.round(((entry.x || entry.expiresAt || 0) - now) / 1000) + 's',
      expired:   now > (entry.x || entry.expiresAt || 0),
    }));
    res.json({ cacheEntries: entries.length, entries });
  } catch {
    res.json({ cacheEntries: 0, note: 'No cache yet' });
  }
});
app.get('/cache/clear',  doClearCache);
app.post('/cache/clear', doClearCache);
function doClearCache(req, res) {
  const { clearAllCache } = require('./src/services/zohoBooks');
  clearAllCache();
  res.json({ success: true, message: 'Cache cleared' });
}

// ── Zoho OAuth callback ───────────────────────────────────
app.get('/zoho/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code received.');
  const axios = require('axios');
  try {
    const r = await axios.post(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
      params: {
        code, grant_type: 'authorization_code',
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri:  `${process.env.APP_URL || `http://localhost:${PORT}`}/zoho/callback`,
      },
    });
    res.send(`<h2>✅ Success!</h2><pre style="background:#f4f4f4;padding:16px;border-radius:8px">ZOHO_REFRESH_TOKEN=${r.data.refresh_token}</pre><p>Copy this to your Vercel env vars.</p>`);
  } catch (err) {
    res.send(`<h2>❌ Error</h2><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ GLC Dealer Portal → http://localhost:${PORT}`);
    console.log(`   Cache: http://localhost:${PORT}/cache/status`);
    console.log(`   Clear: http://localhost:${PORT}/cache/clear\n`);
  });
}

module.exports = app;