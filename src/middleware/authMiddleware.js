/**
 * authMiddleware.js — JWT verification for dealer and admin routes
 */
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token =
    req.cookies?.glc_token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.dealer = decoded;
    next();
  } catch {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Invalid or expired token' });
    res.clearCookie('glc_token');
    return res.redirect('/login');
  }
}

function adminMiddleware(req, res, next) {
  if (!req.dealer?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authMiddleware, adminMiddleware };