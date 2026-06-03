/**
 * dashboard.js — Route: /api/dashboard
 * Auth applied at server.js level (authMiddleware).
 * Returns exact shape expected by dashboard.html renderDashboard().
 */

const express = require('express');
const {
  getInvoicesForCustomer,
  getInvoiceById,
  getDealerOutstanding,
} = require('../services/zohoBooks');
const {
  processCashDiscounts,
  calculateRebate,
  getRules,
} = require('../services/schemeEngine');

const router = express.Router();

// GET /api/dashboard
router.get('/', async (req, res) => {
  try {
    const { contactId, name, category, email } = req.dealer;
    const dealerCategory = category || 'Standard';

    // Fetch invoices + outstanding in parallel. Cash discount uses invoice payment metadata.
    const [invoices, outstanding] = await Promise.all([
      getInvoicesForCustomer(contactId),
      getDealerOutstanding(contactId).catch(() => 0),
    ]);

    // Scheme calculations
    const cashDiscount = processCashDiscounts(invoices, [], dealerCategory);
    const rebate       = calculateRebate(invoices, dealerCategory);
    const rules        = getRules(dealerCategory);

    // Summary
    const openStatuses = ['unpaid', 'sent', 'overdue', 'partiallypaid'];
    const openInvoices = invoices.filter(i => openStatuses.includes(i.status)).length;

    // Format invoices for HTML
    function fmtInv(inv) {
      return {
        id:                     inv.invoice_id,
        number:                 inv.invoice_number,
        date:                   inv.date,
        dueDate:                inv.due_date,
        total:                  parseFloat(inv.total   || 0),
        balance:                parseFloat(inv.balance || 0),
        status:                 inv.status,
        display_status:         inv.display_status,
        due_today:              inv.due_today,
        cash_discount_eligible: inv.cash_discount_eligible,
        cash_discount_amount:   inv.cash_discount_amount,
        cash_discount_expires:  inv.cash_discount_expires,
      };
    }

    // Recent 10 invoices sorted newest first
    const recentInvoices = [...invoices]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 10)
      .map(fmtInv);

    res.json({
      success: true,

      dealer: {
        name:      name  || email || 'Dealer',
        category:  dealerCategory,
        email:     email || '',
        contactId,
      },

      outstanding: {
        outstanding: parseFloat(outstanding || 0),
        currency:    'AED',
      },

      recentInvoices,

      cashDiscount,

      rebate,

      summary: {
        openInvoices,
        totalInvoices: invoices.length,
      },

      // Scheme rules for renderMySchemes()
      schemeRules: {
        cashDiscountRate: (rules.cashDiscountRate * 100) + '%',
        cashDiscountDays: rules.cashDiscountDays,
        rebateRate:       (rules.rebateRate * 100) + '%',
        rebateCap:        'AED ' + rules.rebateCap.toLocaleString(),
        category:         dealerCategory,
      },

      // Full invoice list for the Invoices tab
      invoices: invoices.map(fmtInv),
    });

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
