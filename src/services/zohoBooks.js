/**
 * zohoBooks.js  –  GLC Dealer Portal
 * CommonJS (require/module.exports) — matches the rest of the project.
 *
 * Fixes applied vs original:
 *  1. All invoice statuses fetched (Status.All + explicit Status.Sent)
 *  2. Cash-discount logic: 3% if paid within 15 days of invoice date
 *  3. Incremental sync via last_modified_time
 *  4. All functions needed by auth.js, admin.js, orders.js, dashboard.js included
 */

const axios = require('axios');
const { getAuthHeader, getAccessToken } = require('./zohoAuth');

const BOOKS_URL = process.env.ZOHO_BOOKS_URL || 'https://www.zohoapis.com/books/v3';
const ORG_ID    = process.env.ZOHO_ORG_ID;

// ─── Simple file-based cache (works on Vercel /tmp) ─────────
const path = require('path');
const fs   = require('fs');
const CACHE_FILE = process.env.VERCEL ? '/tmp/.glc-cache.json' : path.join(__dirname, '../../.cache.json');

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(store) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(store)); } catch {}
}
function getCache(key) {
  const store = readCache();
  const entry = store[key];
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}
function setCache(key, data, ttlMs = 10 * 60 * 1000) {
  const store = readCache();
  store[key] = { data, expiresAt: Date.now() + ttlMs };
  writeCache(store);
}
function clearAllCache() {
  try { fs.writeFileSync(CACHE_FILE, '{}'); } catch {}
}

// ─── Incremental sync watermarks ────────────────────────────
// Stored in cache file so they survive between requests on Vercel
function getSyncWatermark(key) {
  const store = readCache();
  return store[`wm_${key}`]?.ts || null;
}
function setSyncWatermark(key, ts) {
  const store = readCache();
  store[`wm_${key}`] = { ts };
  writeCache(store);
}

// ─── Generic paginated GET ───────────────────────────────────
async function booksGet(endpoint, params = {}) {
  const auth = await getAuthHeader();
  let page = 1, hasMore = true, all = [];

  while (hasMore && page <= 10) {
    const { data } = await axios.get(`${BOOKS_URL}${endpoint}`, {
      headers: { Authorization: auth },
      params:  { organization_id: ORG_ID, per_page: 200, page, ...params },
      timeout: 25000,
    });
    if (data.code !== 0) throw new Error(`Zoho error [${endpoint}]: ${data.message}`);
    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'page_context');
    if (key) all.push(...data[key]);
    hasMore = data.page_context?.has_more_page ?? false;
    page++;
  }
  return all;
}

// ─── Cash discount enrichment ────────────────────────────────
const DISC_DAYS = 15;
const DISC_RATE = 0.03;

function enrichInvoice(inv) {
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const dueDate     = inv.due_date ? new Date(inv.due_date) : null;
  const invoiceDate = inv.date     ? new Date(inv.date)     : null;

  const due_today = dueDate
    && dueDate.getFullYear() === today.getFullYear()
    && dueDate.getMonth()    === today.getMonth()
    && dueDate.getDate()     === today.getDate();

  let cashEligible = false, cashAmount = 0, discountExpiry = null;

  if (invoiceDate) {
    discountExpiry = new Date(invoiceDate);
    discountExpiry.setDate(discountExpiry.getDate() + DISC_DAYS);

    const isPaid  = inv.status === 'paid' && Number(inv.balance) === 0;
    const lastPay = inv.last_payment_date ? new Date(inv.last_payment_date) : null;

    if (isPaid && lastPay) {
      cashEligible = Math.floor((lastPay - invoiceDate) / 86400000) <= DISC_DAYS;
    } else if (!isPaid) {
      cashEligible = today <= discountExpiry;
    }
    if (cashEligible) cashAmount = +(Number(inv.total) * DISC_RATE).toFixed(2);
  }

  const STATUS_MAP = {
    due_today: 'Due Today', sent: 'Sent', draft: 'Draft',
    overdue: 'Overdue', paid: 'Paid', unpaid: 'Unpaid',
    partiallypaid: 'Partially Paid', void: 'Void',
  };
  const rawStatus = due_today && inv.status !== 'paid' ? 'due_today' : inv.status;

  return {
    ...inv,
    due_today,
    display_status:         STATUS_MAP[rawStatus] || inv.status,
    cash_discount_eligible: cashEligible,
    cash_discount_amount:   cashAmount,
    cash_discount_expires:  discountExpiry ? discountExpiry.toISOString().split('T')[0] : null,
  };
}

// ════════════════════════════════════════════════════════════
// DEALER / CONTACT FUNCTIONS
// ════════════════════════════════════════════════════════════

async function getDealerByEmail(email) {
  const cacheKey = `dealer_email_${email}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const list = await booksGet('/contacts', {
    contact_type: 'customer',
    search_text:  email,
  });
  const dealer = list.find(c => c.email?.toLowerCase() === email.toLowerCase()) || null;
  if (dealer) setCache(cacheKey, dealer, 30 * 60 * 1000); // 30 min
  return dealer;
}

async function getAllDealers() {
  const cacheKey = 'all_dealers';
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const dealers = await booksGet('/contacts', { contact_type: 'customer' });
  setCache(cacheKey, dealers, 15 * 60 * 1000);
  return dealers;
}

async function getDealerById(contactId) {
  const auth = await getAuthHeader();
  const { data } = await axios.get(`${BOOKS_URL}/contacts/${contactId}`, {
    headers: { Authorization: auth },
    params:  { organization_id: ORG_ID },
    timeout: 15000,
  });
  if (data.code !== 0) throw new Error(data.message);
  return data.contact;
}

// ════════════════════════════════════════════════════════════
// INVOICE FUNCTIONS
// ════════════════════════════════════════════════════════════

/**
 * getInvoicesForDealer — for admin views (no incremental)
 */
async function getInvoicesForDealer(contactId) {
  const all  = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.All' });
  const sent = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.Sent' });
  const seen = new Set(all.map(i => i.invoice_id));
  for (const inv of sent) if (!seen.has(inv.invoice_id)) { all.push(inv); seen.add(inv.invoice_id); }
  return all.map(enrichInvoice);
}

/**
 * getInvoicesForCustomer — for dealer dashboard (with incremental sync)
 */
async function getInvoicesForCustomer(contactId, opts = {}) {
  const wmKey    = `${ORG_ID}_inv_${contactId}`;
  const lastSync = opts.incrementalOnly ? getSyncWatermark(wmKey) : null;

  let invoices = [];

  if (lastSync) {
    console.log(`[ZohoBooks] Incremental sync since ${lastSync}`);
    invoices = await booksGet('/invoices', {
      customer_id: contactId, filter_by: 'Status.All', last_modified_time: lastSync,
    });
  } else {
    console.log(`[ZohoBooks] Full sync for ${contactId}`);
    invoices = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.All' });
    // Explicit Sent fetch — Zoho sometimes excludes it from Status.All
    const sent = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.Sent' });
    const seen = new Set(invoices.map(i => i.invoice_id));
    for (const inv of sent) if (!seen.has(inv.invoice_id)) { invoices.push(inv); seen.add(inv.invoice_id); }
  }

  setSyncWatermark(wmKey, new Date().toISOString().replace('Z', '+00:00'));
  return invoices.map(enrichInvoice);
}

async function getInvoiceById(invoiceId) {
  const auth = await getAuthHeader();
  const { data } = await axios.get(`${BOOKS_URL}/invoices/${invoiceId}`, {
    headers: { Authorization: auth },
    params:  { organization_id: ORG_ID },
    timeout: 15000,
  });
  if (data.code !== 0) throw new Error(data.message);
  return enrichInvoice(data.invoice);
}

// ════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════

async function getPaymentsForDealer(contactId) {
  return booksGet('/customerpayments', { customer_id: contactId });
}

async function getDealerOutstanding(contactId) {
  const dealer = await getDealerById(contactId);
  return dealer?.outstanding_receivable_amount || 0;
}

// ════════════════════════════════════════════════════════════
// SALES ORDERS
// ════════════════════════════════════════════════════════════

async function createSalesOrder({ contactId, lineItems, notes }) {
  const auth = await getAuthHeader();
  const body = {
    customer_id: contactId,
    line_items:  lineItems.map(li => ({
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
  return data.salesorder;
}

async function getSalesOrdersForDealer(contactId) {
  const cacheKey = `orders_${contactId}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const orders = await booksGet('/salesorders', { customer_id: contactId });
  setCache(cacheKey, orders, 5 * 60 * 1000); // 5 min
  return orders;
}

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════
module.exports = {
  // Auth
  getDealerByEmail,

  // Dealers
  getAllDealers,
  getDealerById,

  // Invoices
  getInvoicesForCustomer,
  getInvoicesForDealer,
  getInvoiceById,

  // Payments
  getPaymentsForDealer,
  getDealerOutstanding,

  // Orders
  createSalesOrder,
  getSalesOrdersForDealer,

  // Cache
  clearAllCache,
};