/**
 * dashboard.js — Route: /api/dashboard
 * Auth is applied at server.js level — no middleware import needed here.
 *
 * GET /api/dashboard            → invoices + stats (dashboard.html line 1003)
 * GET /api/dashboard/invoice/:id → single invoice for modal (dashboard.html line 1353)
 */

const express = require('express');
const {
  getInvoicesForCustomer,
  getInvoiceById,
} = require('../services/zohoBooks');

const router = express.Router();

// GET /api/dashboard
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
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/invoice/:id
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