/**
 * dashboard.js — passes dealer category to scheme engine
 */
const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  getDealerById, getDealerOutstanding,
  getInvoicesForDealer, getPaymentsForDealer,
} = require('../services/zohoBooks');
const { processCashDiscounts, calculateRebate, getRules } = require('../services/schemeEngine');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { contactId, name, email, category, isAdmin } = req.dealer;

    if (isAdmin || contactId === 'ADMIN') {
      return res.json({
        success: true,
        dealer: { name: 'GLC Admin', email, category: 'Admin', phone: '' },
        outstanding: { outstanding: 0, unusedCredits: 0, currency: 'AED' },
        recentInvoices: [], schemeRules: null,
        cashDiscount: { totalDiscount: 0, eligibleCount: 0, totalProcessed: 0, recentEligible: [] },
        rebate: {
          cycleStart: new Date().toISOString().split('T')[0],
          cycleEnd: new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0],
          totalPurchases: 0, rebateEarned: 0, rebateCapped: false,
          maxRebate: 10000, rebateRate: 3, progress: 0, daysLeft: 90, invoiceCount: 0,
        },
        summary: { totalInvoices: 0, openInvoices: 0, totalPayments: 0 },
        isAdmin: true,
      });
    }

    console.log('[Dashboard] contactId:', contactId, '| category:', category);

    const [dealer, outstanding, invoices, payments] = await Promise.all([
      getDealerById(contactId).catch(() => null),
      getDealerOutstanding(contactId).catch(() => ({ outstanding: 0, unusedCredits: 0, currency: 'AED' })),
      getInvoicesForDealer(contactId).catch(() => []),
      getPaymentsForDealer(contactId).catch(() => []),
    ]);

    console.log('[Dashboard] invoices:', invoices.length, '| payments:', payments.length);

    // Pass category to scheme engine — Premium gets better rates
    const cashDiscount = processCashDiscounts(invoices, payments, category);
    const rebate       = calculateRebate(invoices, category);
    const schemeRules  = getRules(category);

    const recentInvoices = invoices.slice(0, 5).map(inv => ({
      id: inv.invoice_id, number: inv.invoice_number,
      date: inv.date, dueDate: inv.due_date,
      total: inv.total, balance: inv.balance,
      status: inv.status, currency: inv.currency_code,
    }));

    res.json({
      success: true,
      dealer: {
        name:     dealer?.contact_name || name,
        email:    dealer?.email        || email,
        category,
        phone:    dealer?.phone        || '',
      },
      outstanding,
      recentInvoices,
      schemeRules: {
        category,
        cashDiscountRate: schemeRules.cashDiscountRate * 100 + '%',
        cashDiscountDays: schemeRules.cashDiscountDays,
        rebateRate:       schemeRules.rebateRate * 100 + '%',
        rebateCap:        'AED ' + schemeRules.rebateCap.toLocaleString(),
      },
      cashDiscount: {
        totalDiscount:  cashDiscount.totalDiscount,
        eligibleCount:  cashDiscount.eligibleCount,
        totalProcessed: cashDiscount.totalProcessed,
        recentEligible: cashDiscount.eligible.slice(0, 3),
      },
      rebate,
      summary: {
        totalInvoices: invoices.length,
        openInvoices:  invoices.filter(i => ['sent','partial','overdue'].includes(i.status)).length,
        totalPayments: payments.length,
      },
    });

  } catch (err) {
    console.error('[Dashboard] Error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data', detail: err.message });
  }
});

module.exports = router;
