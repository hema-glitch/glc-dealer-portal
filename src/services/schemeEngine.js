/**
 * schemeEngine.js
 * Business logic: FOC, Cash Discount, Rebate — with dealer category support.
 *
 * DEALER CATEGORIES:
 *  Standard : base schemes only
 *  Premium  : all Standard schemes + enhanced rebate rate + extended cash discount window
 */

// ─── FOC CONFIG ───────────────────────────────────────────────────────────────
// Key = Zoho Item ID.  Add your real item IDs here.
// categories: ['Standard','Premium'] means both see it; ['Premium'] = Premium only.
const FOC_CONFIG = {
  // Example — replace with real Zoho Item IDs:
  // 'ZOHO_ITEM_ID_001': { slabBuy: 10, slabFree: 2, name: 'Interior Emulsion 4L',  categories: ['Standard','Premium'] },
  // 'ZOHO_ITEM_ID_002': { slabBuy:  5, slabFree: 1, name: 'Exterior Paint 20L',     categories: ['Premium'] },
};

// ─── SCHEME RULES BY CATEGORY ─────────────────────────────────────────────────
const SCHEME_RULES = {
  Standard: {
    cashDiscountRate:    0.03,   // 3%
    cashDiscountDays:   15,      // must pay within 15 days
    rebateRate:         0.03,    // 3%
    rebateCap:          10000,   // AED 10,000
    rebateCycleDays:    90,
  },
  Premium: {
    cashDiscountRate:    0.03,   // same rate
    cashDiscountDays:   20,      // extended window: 20 days
    rebateRate:         0.04,    // better rate: 4%
    rebateCap:          15000,   // higher cap: AED 15,000
    rebateCycleDays:    90,
  },
};

function getRules(category) {
  return SCHEME_RULES[category] || SCHEME_RULES.Standard;
}

// ─── FOC ──────────────────────────────────────────────────────────────────────

function calculateFOC(itemId, quantity, category = 'Standard') {
  const config = FOC_CONFIG[itemId];
  if (!config) return { billableQty: quantity, freeQty: 0, scheme: null };

  // Check if this dealer category is eligible for the FOC
  if (config.categories && !config.categories.includes(category)) {
    return { billableQty: quantity, freeQty: 0, scheme: null };
  }

  const { slabBuy, slabFree, name } = config;
  const freeQty = Math.floor(quantity / slabBuy) * slabFree;
  return {
    billableQty: quantity,
    freeQty,
    scheme: freeQty > 0 ? `Buy ${slabBuy} Get ${slabFree} Free — ${name}` : null,
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
  const daysTaken   = Math.floor((paymentDate - invoiceDate) / (1000 * 60 * 60 * 24));
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

function processCashDiscounts(invoices, payments, category = 'Standard') {
  const paymentMap = {};
  payments.forEach(p => { if (p.invoice_id) paymentMap[p.invoice_id] = p; });

  const eligible    = [];
  const notEligible = [];

  invoices.forEach(inv => {
    const payment = paymentMap[inv.invoice_id];
    if (!payment) return;
    const result = checkCashDiscount(inv, payment, category);
    if (result.eligible) eligible.push({ ...result, invoiceTotal: inv.total });
    else notEligible.push({ ...result, invoiceTotal: inv.total });
  });

  return {
    eligible,
    notEligible,
    totalDiscount:  Math.round(eligible.reduce((s, e) => s + e.discountAmount, 0) * 100) / 100,
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
  const rebateCapped   = rawRebate > rules.rebateCap;
  const today          = new Date();
  const daysLeft       = Math.max(0, Math.floor((end - today) / (1000 * 60 * 60 * 24)));
  const progress       = Math.min(100, Math.round((totalPurchases / (rules.rebateCap / rules.rebateRate)) * 100));

  return {
    cycleStart:     start.toISOString().split('T')[0],
    cycleEnd:       end.toISOString().split('T')[0],
    totalPurchases: Math.round(totalPurchases * 100) / 100,
    rebateEarned:   Math.round(rebateEarned   * 100) / 100,
    rebateCapped,
    maxRebate:      rules.rebateCap,
    rebateRate:     rules.rebateRate * 100,
    progress,
    daysLeft,
    invoiceCount:   cycleInvoices.length,
    category,
  };
}

module.exports = {
  calculateFOC, calculateCartFOC,
  checkCashDiscount, processCashDiscounts,
  calculateRebate,
  getRules, FOC_CONFIG, SCHEME_RULES,
};
