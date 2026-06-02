/**
 * authMiddleware.js
 * Verifies the JWT token sent by the dealer browser (cookie or Authorization header).
 */

const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  // Check cookie first, then Authorization header
  const token =
    req.cookies?.glc_token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) {
    // API request — return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Page request — redirect to login
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.dealer = decoded; // { contactId, email, name, category }
    next();
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.clearCookie('glc_token');
    return res.redirect('/login');
  }
}

/**
 * Admin-only middleware — checks if the logged-in user is an admin.
 */
function adminMiddleware(req, res, next) {
  if (!req.dealer?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authMiddleware, adminMiddleware };
