/**
 * schemeEngine.js
 * Business logic: FOC, Cash Discount, Rebate — with dealer category support.
 *
 * FOC CONFIG: Edit via Admin Panel → FOC Config tab.
 * Config is saved to /tmp/foc-config.json on Vercel (persists within a container).
 * For permanent persistence: copy the JSON shown in admin and update FOC_DEFAULTS below.
 */

const fs   = require('fs');
const path = require('path');

const FOC_CONFIG_FILE = process.env.VERCEL
  ? '/tmp/foc-config.json'
  : path.join(__dirname, '../../foc-config.json');

// ─── DEFAULT FOC CONFIG (hardcoded fallback) ──────────────────────────────────
// Replace with real Zoho Item IDs. Find them in Admin → FOC Config → Product List.
// Format: 'ZOHO_ITEM_ID': { slabBuy: 10, slabFree: 2, name: 'Product Name', categories: ['Standard','Premium'] }
const FOC_DEFAULTS = {
  // EXAMPLE (uncomment and replace with real IDs):
  // '4815000000085085': { slabBuy: 10, slabFree: 2, name: 'Acrylic Putty', categories: ['Standard','Premium'] },
  // '4815000000085091': { slabBuy:  5, slabFree: 1, name: 'Al Moukawem',   categories: ['Premium'] },
};

// ─── Read config ─────────────────────────────────────────────────────────────
// Priority: 1) FOC_CONFIG_JSON env var (works across all Vercel containers)
//           2) /tmp/foc-config.json (same container only)
//           3) FOC_DEFAULTS (hardcoded fallback)
function getFOCConfig() {
  // 1. Env var — shared across all serverless containers
  if (process.env.FOC_CONFIG_JSON) {
    try { return JSON.parse(process.env.FOC_CONFIG_JSON); } catch {}
  }
  // 2. /tmp file — same container only (local dev or same warm container)
  try {
    if (fs.existsSync(FOC_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(FOC_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[SchemeEngine] Error reading FOC config file:', e.message);
  }
  // 3. Hardcoded defaults
  return { ...FOC_DEFAULTS };
}

// ─── Save config ──────────────────────────────────────────────────────────────
// Saves to /tmp for same-container access.
// Also logs the vercel env command needed for permanent cross-container persistence.
function saveFOCConfig(config) {
  try { fs.writeFileSync(FOC_CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
  // Log for admin reference
  console.log('[SchemeEngine] FOC config updated. For permanent save run:');
  console.log(`npx vercel env add FOC_CONFIG_JSON`);
  console.log('Value:', JSON.stringify(config));
}

// ─── FOC_CONFIG proxy (always reads latest) ───────────────────────────────────
// Use getFOCConfig() in runtime code so it picks up dynamic changes
const FOC_CONFIG = new Proxy({}, {
  get(_, key) { return getFOCConfig()[key]; },
  has(_, key) { return key in getFOCConfig(); },
  ownKeys()   { return Object.keys(getFOCConfig()); },
  getOwnPropertyDescriptor(_, key) {
    return { enumerable: true, configurable: true, value: getFOCConfig()[key] };
  },
});

// ─── SCHEME RULES BY CATEGORY ─────────────────────────────────────────────────
const SCHEME_RULES = {
  Standard: {
    cashDiscountRate:  0.03,
    cashDiscountDays:  15,
    rebateRate:        0.03,
    rebateCap:         10000,
    rebateCycleDays:   90,
  },
  Premium: {
    cashDiscountRate:  0.03,
    cashDiscountDays:  20,
    rebateRate:        0.04,
    rebateCap:         15000,
    rebateCycleDays:   90,
  },
};

function getRules(category) {
  return SCHEME_RULES[category] || SCHEME_RULES.Standard;
}

// ─── FOC ──────────────────────────────────────────────────────────────────────

function calculateFOC(itemId, quantity, category = 'Standard') {
  const cfg = getFOCConfig();
  const config = cfg[itemId];
  if (!config) return { billableQty: quantity, freeQty: 0, scheme: null };
  if (config.categories && !config.categories.includes(category)) {
    return { billableQty: quantity, freeQty: 0, scheme: null };
  }
  const freeQty = Math.floor(quantity / config.slabBuy) * config.slabFree;
  return {
    billableQty: quantity,
    freeQty,
    scheme: freeQty > 0 ? `Buy ${config.slabBuy} Get ${config.slabFree} Free — ${config.name}` : null,
  };
}

function calculateCartFOC(cartItems, category = 'Standard') {
  return cartItems.map(item => ({
    ...item,
    ...calculateFOC(item.itemId, item.quantity, category),
  }));
}

// ─── CASH DISCOUNT ────────────────────────────────────────────────────────────

function checkCashDiscount(invoice, payment, category = 'Standard') {
  const rules      = getRules(category);
  const invoiceDate = new Date(invoice.date);
  const paymentDate = new Date(payment.date);
  const daysTaken   = Math.floor((paymentDate - invoiceDate) / 86400000);
  const paidInFull  = parseFloat(payment.amount) >= parseFloat(invoice.total) * 0.99;
  const paidOnTime  = daysTaken <= rules.cashDiscountDays;
  const eligible    = paidInFull && paidOnTime;

  return {
    invoiceId:      invoice.invoice_id || invoice.invoice_number,
    eligible,
    discountAmount: eligible ? Math.round(parseFloat(invoice.total) * rules.cashDiscountRate * 100) / 100 : 0,
    daysTaken,
    paidInFull,
    paidOnTime,
    windowDays:     rules.cashDiscountDays,
    reason: !eligible
      ? (!paidInFull ? 'Payment not in full' : `Paid after ${daysTaken} days (limit: ${rules.cashDiscountDays})`)
      : `Paid within ${daysTaken} days ✓`,
  };
}

function paymentFromInvoice(inv) {
  const isPaid = inv.status === 'paid' && Number(inv.balance || 0) === 0;
  if (!isPaid || !inv.last_payment_date) return null;
  return {
    invoice_id: inv.invoice_id,
    date: inv.last_payment_date,
    amount: inv.total,
  };
}

function processCashDiscounts(invoices, payments = [], category = 'Standard') {
  const paymentMap = {};
  payments.forEach(p => { if (p.invoice_id) paymentMap[p.invoice_id] = p; });

  const eligible = [], notEligible = [];
  invoices.forEach(inv => {
    const payment = paymentMap[inv.invoice_id] || paymentFromInvoice(inv);
    if (!payment) return;
    const result = checkCashDiscount(inv, payment, category);
    if (result.eligible) eligible.push({ ...result, invoiceTotal: inv.total });
    else notEligible.push({ ...result, invoiceTotal: inv.total });
  });

  return {
    eligible,
    notEligible,
    totalDiscount:  Math.round(eligible.reduce((s,e) => s + e.discountAmount, 0) * 100) / 100,
    eligibleCount:  eligible.length,
    totalProcessed: eligible.length + notEligible.length,
  };
}

// ─── REBATE ───────────────────────────────────────────────────────────────────

function getQuarterStart() {
  const now     = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  return new Date(now.getFullYear(), quarter * 3, 1);
}

function calculateRebate(invoices, category = 'Standard', cycleStartDate = null) {
  const rules = getRules(category);
  const start = cycleStartDate ? new Date(cycleStartDate) : getQuarterStart();
  const end   = new Date(start);
  end.setDate(end.getDate() + rules.rebateCycleDays);

  const cycleInvoices = invoices.filter(inv => {
    const d = new Date(inv.date);
    return d >= start && d <= end && inv.status !== 'void';
  });

  const totalPurchases = cycleInvoices.reduce((s, inv) => s + parseFloat(inv.total || 0), 0);
  const rawRebate      = totalPurchases * rules.rebateRate;
  const rebateEarned   = Math.min(rawRebate, rules.rebateCap);
  const today          = new Date();
  const daysLeft       = Math.max(0, Math.floor((end - today) / 86400000));
  const progress       = Math.min(100, Math.round((totalPurchases / (rules.rebateCap / rules.rebateRate)) * 100));

  return {
    cycleStart:     start.toISOString().split('T')[0],
    cycleEnd:       end.toISOString().split('T')[0],
    totalPurchases: Math.round(totalPurchases * 100) / 100,
    rebateEarned:   Math.round(rebateEarned   * 100) / 100,
    rebateCapped:   rawRebate > rules.rebateCap,
    maxRebate:      rules.rebateCap,
    rebateRate:     rules.rebateRate * 100,
    progress,
    daysLeft,
    invoiceCount:   cycleInvoices.length,
    category,
  };
}

module.exports = {
  getFOCConfig, saveFOCConfig,
  calculateFOC, calculateCartFOC,
  checkCashDiscount, processCashDiscounts,
  calculateRebate,
  getRules, FOC_CONFIG, SCHEME_RULES,
};
