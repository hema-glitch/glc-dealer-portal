/**
 * admin.js — Route: /api/admin
 * Auth + admin guard applied at server.js level.
 */

const express = require('express');
const {
  getAllDealers, getDealerById,
  getInvoicesForDealer, getPaymentsForDealer,
  getDealerOutstanding,
} = require('../services/zohoBooks');
const { processCashDiscounts, calculateRebate, getRules } = require('../services/schemeEngine');

const router = express.Router();

// ─── GET /api/admin/dealers ──────────────────────────────────
router.get('/dealers', async (req, res) => {
  try {
    const dealers = await getAllDealers();
    const summary = dealers.map(d => ({
      id:          d.contact_id,
      name:        d.contact_name || '—',
      email:       d.email        || '—',
      phone:       d.phone        || '—',
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

// ─── GET /api/admin/dealer/:id ───────────────────────────────
// Full dealer report — invoices, payments, cash discount, rebate
router.get('/dealer/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [dealer, invoices, payments, outstandingAmt] = await Promise.all([
      getDealerById(id),
      getInvoicesForDealer(id),
      getPaymentsForDealer(id).catch(() => []),
      getDealerOutstanding(id).catch(() => 0),
    ]);

    const category    = dealer?.custom_fields?.find(f => f.label === 'Dealer Category')?.value || 'Standard';
    const cashDiscount = processCashDiscounts(invoices, payments, category);
    const rebate       = calculateRebate(invoices, category);
    const rules        = getRules(category);

    res.json({
      success: true,
      dealer: {
        id, name: dealer?.contact_name || '—',
        email: dealer?.email || '—', phone: dealer?.phone || '—', category,
      },
      // FIX: was returning bare number — admin.html reads outstanding.outstanding
      outstanding: {
        outstanding: parseFloat(outstandingAmt || 0),
        currency: 'AED',
      },
      invoices: invoices.slice(0, 20).map(inv => ({
        id:      inv.invoice_id,   number:  inv.invoice_number,
        date:    inv.date,         dueDate: inv.due_date,
        total:   parseFloat(inv.total   || 0),
        balance: parseFloat(inv.balance || 0),
        status:  inv.status,
        display_status:         inv.display_status,
        cash_discount_eligible: inv.cash_discount_eligible,
        cash_discount_amount:   inv.cash_discount_amount,
      })),
      cashDiscount,
      rebate,
      schemeRules: {
        cashDiscountRate: (rules.cashDiscountRate * 100) + '%',
        cashDiscountDays: rules.cashDiscountDays,
        rebateRate:       (rules.rebateRate * 100) + '%',
        rebateCap:        rules.rebateCap,
        category,
      },
      summary: {
        totalInvoices: invoices.length,
        totalPaid:     invoices.filter(i => i.status === 'paid').length,
        totalOverdue:  invoices.filter(i => i.status === 'overdue').length,
        openInvoices:  invoices.filter(i => ['unpaid','sent','overdue','partiallypaid'].includes(i.status)).length,
      },
    });
  } catch (err) {
    console.error('[Admin] dealer detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/summary ──────────────────────────────────
// High-level KPIs for overview page
router.get('/summary', async (req, res) => {
  try {
    const dealers = await getAllDealers();
    const totalOutstanding = dealers.reduce((s, d) =>
      s + parseFloat(d.outstanding_receivable_amount || 0), 0);
    res.json({
      success: true,
      totalDealers:    dealers.length,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      currency: 'AED',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ─── GET /api/admin/products ─────────────────────────────────
// Lists all products with their Zoho item_id exposed (needed for FOC config)
router.get('/products', async (req, res) => {
  try {
    const { getAllProducts } = require('../services/zohoInventory');
    const { getFOCConfig }   = require('../services/schemeEngine');
    const items     = await getAllProducts();
    const focConfig = getFOCConfig();

    const products = items.map(item => ({
      item_id:  item.item_id,
      name:     item.name,
      sku:      item.sku || '',
      rate:     item.rate || 0,
      stock:    item.available_stock || item.stock_on_hand || 0,
      category: item.category_name || 'General',
      foc:      focConfig[item.item_id] || null,
    }));

    res.json({ success: true, products });
  } catch (err) {
    console.error('[Admin] products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/foc-config ───────────────────────────────
router.get('/foc-config', (req, res) => {
  const { getFOCConfig } = require('../services/schemeEngine');
  res.json({ success: true, config: getFOCConfig() });
});

// ─── POST /api/admin/foc-config ──────────────────────────────
// Body: { item_id, slabBuy, slabFree, name, categories, active }
// Send active:false to remove a product from FOC
router.post('/foc-config', (req, res) => {
  try {
    const { getFOCConfig, saveFOCConfig } = require('../services/schemeEngine');
    const { item_id, slabBuy, slabFree, name, categories, active } = req.body;

    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const config = getFOCConfig();

    if (active === false || active === 'false') {
      delete config[item_id];
    } else {
      config[item_id] = {
        slabBuy:    parseInt(slabBuy)  || 10,
        slabFree:   parseInt(slabFree) || 2,
        name:       name || item_id,
        categories: categories || ['Standard', 'Premium'],
      };
    }

    saveFOCConfig(config);
    res.json({ success: true, config });
  } catch (err) {
    console.error('[Admin] foc-config save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});