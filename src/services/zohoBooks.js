/**
 * zohoBooks.js  –  GLC Dealer Portal
 * CommonJS — matches server.js, auth.js, admin.js, orders.js, products.js
 */

const axios = require('axios');
const { getAuthHeader } = require('./zohoAuth');
const {
  remember,
  setCache,
  deleteCache,
  deletePrefix,
  clearAllCache: clearCacheStore,
} = require('./cacheStore');

const BOOKS_URL = process.env.ZOHO_BOOKS_URL || 'https://www.zohoapis.com/books/v3';
const ORG_ID    = process.env.ZOHO_ORG_ID;

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const TTL = {
  dealer:    envMs('CACHE_TTL_DEALER_MS',    6 * 60 * 60 * 1000),
  dealers:   envMs('CACHE_TTL_DEALERS_MS',   6 * 60 * 60 * 1000),
  financial: envMs('CACHE_TTL_FINANCIAL_MS', 6 * 60 * 60 * 1000),
  orders:    envMs('CACHE_TTL_ORDERS_MS',   30 * 60 * 1000),
};

// ─── Generic paginated GET ────────────────────────────────────
async function booksGet(endpoint, params = {}) {
  const auth = await getAuthHeader();
  let page = 1, hasMore = true, all = [];

  while (hasMore && page <= 10) {
    const { data } = await axios.get(`${BOOKS_URL}${endpoint}`, {
      headers: { Authorization: auth },
      params:  { organization_id: ORG_ID, per_page: 200, page, ...params },
      timeout: 25000,
    });

    // Zoho returns code:0 on success
    if (data.code !== 0) {
      throw new Error(`Zoho API error on ${endpoint}: [${data.code}] ${data.message}`);
    }

    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'page_context');
    if (key) all.push(...data[key]);
    hasMore = data.page_context?.has_more_page ?? false;
    page++;
  }
  return all;
}

// ─── Invoice enrichment ───────────────────────────────────────
const DISC_DAYS = 15;
const DISC_RATE = 0.03;

function enrichInvoice(inv) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = inv.due_date ? new Date(inv.due_date) : null;
  const idate = inv.date     ? new Date(inv.date)     : null;

  const due_today = due
    && due.getFullYear() === today.getFullYear()
    && due.getMonth()    === today.getMonth()
    && due.getDate()     === today.getDate();

  let cashEligible = false, cashAmount = 0, discExpiry = null;
  if (idate) {
    discExpiry = new Date(idate);
    discExpiry.setDate(discExpiry.getDate() + DISC_DAYS);
    const isPaid  = inv.status === 'paid' && Number(inv.balance) === 0;
    const lastPay = inv.last_payment_date ? new Date(inv.last_payment_date) : null;
    if (isPaid && lastPay) {
      cashEligible = Math.floor((lastPay - idate) / 86400000) <= DISC_DAYS;
    } else if (!isPaid) {
      cashEligible = today <= discExpiry;
    }
    if (cashEligible) cashAmount = +(Number(inv.total) * DISC_RATE).toFixed(2);
  }

  const STATUS_MAP = {
    due_today: 'Due Today', sent: 'Sent', draft: 'Draft', overdue: 'Overdue',
    paid: 'Paid', unpaid: 'Unpaid', partiallypaid: 'Partially Paid', void: 'Void',
  };
  const rs = due_today && inv.status !== 'paid' ? 'due_today' : inv.status;

  return {
    ...inv,
    due_today,
    display_status:         STATUS_MAP[rs] || inv.status,
    cash_discount_eligible: cashEligible,
    cash_discount_amount:   cashAmount,
    cash_discount_expires:  discExpiry ? discExpiry.toISOString().split('T')[0] : null,
  };
}

// ════════════════════════════════════════════════════
// CONTACTS / DEALERS
// ════════════════════════════════════════════════════

async function getDealerByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  return remember(`dealer_email_${normalized}`, TTL.dealer, async () => {
    const list = await booksGet('/contacts', { contact_type: 'customer', search_text: normalized });
    const match = list.find(c => c.email?.toLowerCase() === normalized) || null;
    
    if (!match?.contact_id) return null;

    // ✅ Fetch full contact to get custom_fields (list endpoint strips them)
    const auth = await getAuthHeader();
    const { data } = await axios.get(`${BOOKS_URL}/contacts/${match.contact_id}`, {
      headers: { Authorization: auth },
      params:  { organization_id: ORG_ID },
      timeout: 15000,
    });
    if (data.code !== 0) throw new Error(data.message);
    const dealer = data.contact;
    await setCache(`dealer_detail_${dealer.contact_id}`, dealer, TTL.dealer);
    return dealer;
  });
}

async function getAllDealers() {
  return remember('all_dealers', TTL.dealers, async () => {
    const dealers = await booksGet('/contacts', { contact_type: 'customer' });
    await Promise.all(dealers
      .filter(d => d.contact_id)
      .map(d => setCache(`dealer_detail_${d.contact_id}`, d, TTL.dealer)));
    return dealers;
  });
}

async function getDealerById(contactId) {
  return remember(`dealer_detail_${contactId}`, TTL.dealer, async () => {
    const auth = await getAuthHeader();
    const { data } = await axios.get(`${BOOKS_URL}/contacts/${contactId}`, {
      headers: { Authorization: auth },
      params:  { organization_id: ORG_ID },
      timeout: 15000,
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.contact;
  });
}

// ════════════════════════════════════════════════════
// INVOICES — fetch all statuses including "Sent"
// ════════════════════════════════════════════════════

async function _fetchAllInvoices(contactId) {
  // Fetch Status.All first — covers Draft, Paid, Overdue, Unpaid, PartiallyPaid, Void
  const all  = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.All' });
  // Explicitly fetch Sent — Zoho sometimes excludes it from Status.All
  const sent = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.Sent' });
  const seen = new Set(all.map(i => i.invoice_id));
  for (const inv of sent) {
    if (!seen.has(inv.invoice_id)) { all.push(inv); seen.add(inv.invoice_id); }
  }
  return all;
}

async function getInvoicesCached(contactId) {
  return remember(`invoices_${contactId}`, TTL.financial, async () => {
    console.log(`[ZohoBooks] Fetching invoices for ${contactId}`);
    const invoices = await _fetchAllInvoices(contactId);
    return invoices.map(enrichInvoice);
  });
}

async function getInvoicesForCustomer(contactId) {
  return getInvoicesCached(contactId);
}

async function getInvoicesForDealer(contactId) {
  return getInvoicesCached(contactId);
}

async function getInvoiceById(invoiceId) {
  return remember(`invoice_${invoiceId}`, TTL.financial, async () => {
    const auth = await getAuthHeader();
    const { data } = await axios.get(`${BOOKS_URL}/invoices/${invoiceId}`, {
      headers: { Authorization: auth },
      params:  { organization_id: ORG_ID },
      timeout: 15000,
    });
    if (data.code !== 0) throw new Error(data.message);
    return enrichInvoice(data.invoice);
  });
}

// ════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════

async function getPaymentsForDealer(contactId) {
  return remember(`payments_${contactId}`, TTL.financial, async () =>
    booksGet('/customerpayments', { customer_id: contactId })
  );
}

async function getDealerOutstanding(contactId) {
  try {
    const d = await getDealerById(contactId);
    return d?.outstanding_receivable_amount || 0;
  } catch { return 0; }
}

// ════════════════════════════════════════════════════
// SALES ORDERS
// ════════════════════════════════════════════════════

async function createSalesOrder({ contactId, lineItems, notes }) {
  const auth = await getAuthHeader();
  const body = {
    customer_id: contactId,
    line_items: lineItems.map(li => ({
      item_id:     li.itemId,
      quantity:    li.quantity,
      rate:        li.rate,
      description: li.description || '',
    })),
    notes: notes || '',
  };
  const { data } = await axios.post(`${BOOKS_URL}/salesorders`, body, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    params:  { organization_id: ORG_ID },
    timeout: 20000,
  });
  if (data.code !== 0) throw new Error(data.message);

  const productKeys = lineItems
    .map(li => li.itemId)
    .filter(Boolean)
    .map(itemId => deleteCache(`product_${itemId}`));
  await Promise.all([
    deleteCache(`orders_${contactId}`),
    deleteCache(`dealer_report_${contactId}`),
    deleteCache('products_raw'),
    deleteCache('products_with_foc'),
    ...productKeys,
  ]).catch(err => console.warn('[ZohoBooks] cache invalidation failed:', err.message));

  return data.salesorder;
}

async function getSalesOrdersForDealer(contactId) {
  return remember(`orders_${contactId}`, TTL.orders, async () =>
    booksGet('/salesorders', { customer_id: contactId })
  );
}

async function invalidateDealerData(contactId) {
  if (!contactId) return;
  await Promise.all([
    deleteCache(`dealer_detail_${contactId}`),
    deleteCache(`invoices_${contactId}`),
    deleteCache(`payments_${contactId}`),
    deleteCache(`orders_${contactId}`),
    deleteCache(`dealer_report_${contactId}`),
  ]);
}

async function invalidateContactData(contactId) {
  await Promise.all([
    deleteCache('all_dealers'),
    deletePrefix('dealer_email_'),
    contactId ? deleteCache(`dealer_detail_${contactId}`) : Promise.resolve(),
  ]);
}

async function clearAllCache() {
  await clearCacheStore();
}

// ════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════
module.exports = {
  getDealerByEmail,
  getAllDealers,
  getDealerById,
  getInvoicesForCustomer,
  getInvoicesForDealer,
  getInvoiceById,
  getPaymentsForDealer,
  getDealerOutstanding,
  createSalesOrder,
  getSalesOrdersForDealer,
  invalidateDealerData,
  invalidateContactData,
  clearAllCache,
};
