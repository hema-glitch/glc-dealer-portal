/**
 * admin.js — Route: /api/admin
 * Admin-only endpoints for dealer management and reporting.
 */

const express = require('express');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const {
  getAllDealers, getDealerById,
  getInvoicesForDealer, getPaymentsForDealer,
  getDealerOutstanding,
} = require('../services/zohoBooks');
const { processCashDiscounts, calculateRebate } = require('../services/schemeEngine');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * GET /api/admin/dealers
 * All dealers with their outstanding balance summary
 */
router.get('/dealers', async (req, res) => {
  try {
    const dealers = await getAllDealers();
    const summary = dealers.map(d => ({
      id:          d.contact_id,
      name:        d.contact_name,
      email:       d.email || '—',
      phone:       d.phone || '—',
      outstanding: parseFloat(d.outstanding_receivable_amount || 0),
      currency:    d.currency_code || 'AED',
      status:      d.status,
      category:    d.custom_fields?.find(f => f.label === 'Dealer Category')?.value || 'Standard',
      hasPortal:   !!(d.custom_fields?.find(f => f.label === 'Portal Password')?.value),
    }));
    res.json({ success: true, dealers: summary, total: summary.length });
  } catch (err) {
    console.error('[Admin] dealers error:', err.message);
    res.status(500).json({ error: 'Failed to load dealers' });
  }
});

/**
 * GET /api/admin/dealer/:id
 * Full dealer report: invoices, payments, discount eligibility, rebate
 */
router.get('/dealer/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [dealer, invoices, payments, outstanding] = await Promise.all([
      getDealerById(id),
      getInvoicesForDealer(id),
      getPaymentsForDealer(id),
      getDealerOutstanding(id),
    ]);

    const category = dealer?.custom_fields?.find(f => f.label === 'Dealer Category')?.value || 'Standard';
    const cashDiscount = processCashDiscounts(invoices, payments, category);
    const rebate = calculateRebate(invoices, category);

    res.json({
      success: true,
      dealer: {
        id, name: dealer?.contact_name, email: dealer?.email,
        phone: dealer?.phone, category,
      },
      outstanding,
      invoices: invoices.slice(0, 20).map(inv => ({
        id: inv.invoice_id, number: inv.invoice_number,
        date: inv.date, dueDate: inv.due_date,
        total: inv.total, balance: inv.balance,
        status: inv.status, currency: inv.currency_code,
      })),
      cashDiscount,
      rebate,
      summary: {
        totalInvoices: invoices.length,
        totalPaid: invoices.filter(i => i.status === 'paid').length,
        totalOverdue: invoices.filter(i => i.status === 'overdue').length,
      },
    });
  } catch (err) {
    console.error('[Admin] dealer detail error:', err.message);
    res.status(500).json({ error: 'Failed to load dealer details' });
  }
});

/**
 * GET /api/admin/summary
 * High-level summary: total outstanding, rebate exposure, discount exposure
 */
router.get('/summary', async (req, res) => {
  try {
    const dealers = await getAllDealers();
    const totalOutstanding = dealers.reduce((s, d) =>
      s + parseFloat(d.outstanding_receivable_amount || 0), 0);
    res.json({
      success: true,
      totalDealers: dealers.length,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      currency: 'AED',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

module.exports = router;