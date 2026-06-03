/**
 * zohoBooks.js  –  GLC Dealer Portal
 * CommonJS — matches server.js, auth.js, admin.js, orders.js, products.js
 *
 * Exports:
 *   getDealerByEmail, getAllDealers, getDealerById
 *   getInvoicesForCustomer, getInvoicesForDealer, getInvoiceById
 *   getPaymentsForDealer, getDealerOutstanding
 *   createSalesOrder, getSalesOrdersForDealer
 *   clearAllCache
 */

const axios = require('axios');
const { getAuthHeader } = require('./zohoAuth');
const path = require('path');
const fs   = require('fs');

const BOOKS_URL = process.env.ZOHO_BOOKS_URL || 'https://www.zohoapis.com/books/v3';
const ORG_ID    = process.env.ZOHO_ORG_ID;

// ─── File cache (persists to /tmp on Vercel) ─────────────────
const CACHE_FILE = process.env.VERCEL
  ? '/tmp/.glc-cache.json'
  : path.join(__dirname, '../../.cache.json');

function _readCache()        { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function _writeCache(store)  { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(store));    } catch {} }
function _getCache(key)      { const e = _readCache()[key]; return (e && Date.now() < e.x) ? e.d : null; }
function _setCache(key, d, ttl = 600000) { const s = _readCache(); s[key] = { d, x: Date.now() + ttl }; _writeCache(s); }
function clearAllCache()     { try { fs.writeFileSync(CACHE_FILE, '{}'); } catch {} }

// ─── Incremental sync watermarks (stored in cache file) ──────
function _getWM(key)     { return _readCache()[`wm_${key}`]?.ts || null; }
function _setWM(key, ts) { const s = _readCache(); s[`wm_${key}`] = { ts }; _writeCache(s); }

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
    if (data.code !== 0) throw new Error(`Zoho [${endpoint}]: ${data.message}`);
    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'page_context');
    if (key) all.push(...data[key]);
    hasMore = data.page_context?.has_more_page ?? false;
    page++;
  }
  return all;
}

// ─── Invoice enrichment (due today + cash discount) ──────────
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
    due_today:'Due Today', sent:'Sent', draft:'Draft', overdue:'Overdue',
    paid:'Paid', unpaid:'Unpaid', partiallypaid:'Partially Paid', void:'Void',
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
  const ck = `dealer_${email}`;
  const c  = _getCache(ck);
  if (c) return c;
  const list = await booksGet('/contacts', { contact_type: 'customer', search_text: email });
  const d = list.find(c => c.email?.toLowerCase() === email.toLowerCase()) || null;
  if (d) _setCache(ck, d, 30 * 60000);
  return d;
}

async function getAllDealers() {
  const c = _getCache('all_dealers');
  if (c) return c;
  const dealers = await booksGet('/contacts', { contact_type: 'customer' });
  _setCache('all_dealers', dealers, 15 * 60000);
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

// ════════════════════════════════════════════════════
// INVOICES
// ════════════════════════════════════════════════════

async function _fetchAllInvoicesFor(contactId) {
  const all  = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.All' });
  const sent = await booksGet('/invoices', { customer_id: contactId, filter_by: 'Status.Sent' });
  const seen = new Set(all.map(i => i.invoice_id));
  for (const inv of sent) if (!seen.has(inv.invoice_id)) { all.push(inv); seen.add(inv.invoice_id); }
  return all;
}

// For dealer dashboard — supports incremental sync
async function getInvoicesForCustomer(contactId, opts = {}) {
  const wmKey   = `${ORG_ID}_inv_${contactId}`;
  const lastSync = opts.incrementalOnly ? _getWM(wmKey) : null;
  let invoices;

  if (lastSync) {
    console.log(`[ZohoBooks] Incremental sync since ${lastSync}`);
    invoices = await booksGet('/invoices', {
      customer_id: contactId, filter_by: 'Status.All', last_modified_time: lastSync,
    });
  } else {
    console.log(`[ZohoBooks] Full sync for ${contactId}`);
    invoices = await _fetchAllInvoicesFor(contactId);
  }

  _setWM(wmKey, new Date().toISOString().replace('Z', '+00:00'));
  return invoices.map(enrichInvoice);
}

// For admin views — always full fetch
async function getInvoicesForDealer(contactId) {
  const invoices = await _fetchAllInvoicesFor(contactId);
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

// ════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════

async function getPaymentsForDealer(contactId) {
  return booksGet('/customerpayments', { customer_id: contactId });
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
  return data.salesorder;
}

async function getSalesOrdersForDealer(contactId) {
  const ck = `orders_${contactId}`;
  const c  = _getCache(ck);
  if (c) return c;
  const orders = await booksGet('/salesorders', { customer_id: contactId });
  _setCache(ck, orders, 5 * 60000);
  return orders;
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
  clearAllCache,
};