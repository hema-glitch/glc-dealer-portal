/**
 * dashboard.js — Route: /api/dashboard
 * Dealer invoice data. Auth via JWT (req.dealer injected by authMiddleware).
 *
 * Fixes vs previous version:
 *  1. CommonJS (require/module.exports) — was import/export, broke on startup
 *  2. Uses req.dealer.contactId (JWT) — was req.session?.dealer?.zoho_customer_id (wrong)
 *  3. GET /api/dashboard — main handler for dashboard.html's first fetch
 *  4. GET /api/dashboard/invoice/:id — for invoice modal
 */

const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  getInvoicesForCustomer,
  getInvoiceById,
  getDealerOutstanding,
} = require('../services/zohoBooks');

const router = express.Router();
router.use(authMiddleware);

// ─── GET /api/dashboard ──────────────────────────────────────
// Main data fetch: invoices + stats for the logged-in dealer.
// dashboard.html calls: fetch('/api/dashboard')
// ?refresh=true → force full re-sync from Zoho
router.get('/', async (req, res) => {
  try {
    const contactId    = req.dealer.contactId;
    const forceRefresh = req.query.refresh === 'true';

    const invoices = await getInvoicesForCustomer(contactId, {
      incrementalOnly: !forceRefresh,
    });

    const stats = invoices.reduce(
      (acc, inv) => {
        if (inv.due_today && inv.status !== 'paid') {
          acc.dueTodayCount++;
          acc.dueTodayAmount += Number(inv.balance || 0);
        }
        if (['unpaid', 'sent', 'overdue', 'partiallypaid'].includes(inv.status)) {
          acc.outstanding += Number(inv.balance || 0);
        }
        if (inv.cash_discount_eligible && inv.status !== 'paid') {
          acc.discountAvailable += inv.cash_discount_amount;
        }
        return acc;
      },
      { dueTodayCount: 0, dueTodayAmount: 0, outstanding: 0, discountAvailable: 0 }
    );

    res.json({ success: true, invoices, stats });
  } catch (err) {
    console.error('[dashboard/] error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data', detail: err.message });
  }
});

// ─── GET /api/dashboard/invoice/:id ─────────────────────────
// Single invoice detail for the modal popup.
// dashboard.html calls: fetch(`/api/dashboard/invoice/${invoiceId}`)
router.get('/invoice/:id', async (req, res) => {
  try {
    const invoice = await getInvoiceById(req.params.id);
    res.json({ success: true, invoice });
  } catch (err) {
    console.error('[dashboard/invoice/:id] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;