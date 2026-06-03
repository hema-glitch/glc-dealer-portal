/**
 * auth.js — Route: /api/auth
 * Handles dealer login using Zoho Books contact email + Portal Password custom field.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDealerByEmail } = require('../services/zohoBooks');

const router = express.Router();

// Helper: find a custom field value by label name
// Handles both formats Zoho Books API returns
function getCF(fields, name) {
  if (!fields || !Array.isArray(fields)) return null;
  const f = fields.find(
    (f) =>
      f.label === name ||
      f.cf_label === name ||
      f.api_name === `cf_${name.toLowerCase().replace(/\s+/g, '_')}`
  );
  return f?.value || f?.cf_value || null;
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // ── ADMIN LOGIN (from .env) ──────────────────────────────────────────────
    if (
      email === process.env.ADMIN_EMAIL &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const token = jwt.sign(
        {
          contactId: 'ADMIN',
          email,
          name: 'GLC Admin',
          category: 'admin',
          isAdmin: true,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );

      res.cookie('glc_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 8 * 60 * 60 * 1000,
      });

      return res.json({
        success: true,
        user: { name: 'GLC Admin', email, isAdmin: true },
        redirect: '/admin',
      });
    }

    // ── DEALER LOGIN (from Zoho Books Contacts) ──────────────────────────────
    const dealer = await getDealerByEmail(email);

    if (!dealer) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    console.log('[Auth] Dealer found:', dealer.contact_name);
    console.log('[Auth] Custom fields:', JSON.stringify(dealer.custom_fields));

    const storedPassword = getCF(dealer.custom_fields, 'Portal Password');

    console.log('[Auth] Portal Password field value:', storedPassword);

    if (!storedPassword) {
      return res.status(401).json({
        error: 'Portal access not configured for this account. Please contact GLC support.',
      });
    }

    // Compare password (plain text for POC, bcrypt for production)
    const isValid =
      storedPassword.startsWith('$2')
        ? await bcrypt.compare(password, storedPassword)
        : password === storedPassword;

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const category = getCF(dealer.custom_fields, 'Dealer Category') || 'Standard';

    const token = jwt.sign(
      {
        contactId: dealer.contact_id,
        email: dealer.email,
        name: dealer.contact_name,
        category,
        isAdmin: false,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.cookie('glc_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      user: {
        contactId: dealer.contact_id,
        name: dealer.contact_name,
        email: dealer.email,
        category,
        isAdmin: false,
      },
      redirect: '/dashboard',
    });

  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    console.error('[Auth] Stack:', err.stack);
    res.status(500).json({ error: 'Login failed. Please try again.', detail: err.message });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie('glc_token');
  res.json({ success: true, redirect: '/login' });
});

/**
 * GET /api/auth/me
 */
router.get('/me', (req, res) => {
  const token = req.cookies?.glc_token || req.headers.authorization?.slice(7);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;