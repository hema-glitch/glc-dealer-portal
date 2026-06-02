/**
 * zohoBooks.js — Zoho Books API with cache + Vercel timeout optimization
 * 
 * Vercel Hobby plan = 10s function timeout
 * Solution: Fetch only 3 invoice statuses (covers 99% of real cases)
 * and use aggressive caching
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { getAuthHeader } = require('./zohoAuth');

const BASE_URL   = process.env.ZOHO_BOOKS_URL;
const ORG_ID     = process.env.ZOHO_ORG_ID;
const CACHE_FILE = process.env.VERCEL
  ? '/tmp/.glc-cache.json'
  : path.join(__dirname, '../../.cache.json');

const TTL = {
  contact:  10 * 60 * 1000,
  invoices:  5 * 60 * 1000,
  payments:  5 * 60 * 1000,
};

let memoryCache = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {}
  return memoryCache;
}

function saveCache(store) {
  memoryCache = store;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(store), 'utf8'); } catch {}
}

function cacheGet(key) {
  const store = loadCache();
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { delete store[key]; saveCache(store); return null; }
  console.log('[Cache] HIT:', key);
  return entry.value;
}

function cacheSet(key, value, ttl) {
  const store = loadCache();
  store[key] = { value, expiresAt: Date.now() + ttl };
  saveCache(store);
}

function invalidateDealer(contactId) {
  const store = loadCache();
  Object.keys(store).filter(k => k.includes(contactId)).forEach(k => delete store[k]);
  saveCache(store);
}

function clearAllCache() {
  memoryCache = {};
  try { fs.writeFileSync(CACHE_FILE, '{}', 'utf8'); } catch {}
}

// Timeout wrapper — prevents Vercel 10s limit from being hit
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function zbGet(endpoint, params = {}) {
  const auth = await getAuthHeader();
  try {
    const res = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: { Authorization: auth },
      params: { organization_id: ORG_ID, ...params },
      timeout: 7000, // 7s axios timeout
    });
    return res.data;
  } catch (err) {
    console.error(`[ZohoBooks] GET ${endpoint} failed:`, err.response?.data || err.message);
    throw err;
  }
}

async function zbPost(endpoint, body = {}) {
  const auth = await getAuthHeader();
  const res = await axios.post(`${BASE_URL}${endpoint}`, body, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    params: { organization_id: ORG_ID },
    timeout: 7000,
  });
  return res.data;
}

async function getAllDealers() {
  const data = await zbGet('/contacts', { contact_type: 'customer' });
  return data.contacts || [];
}

async function getDealerById(contactId) {
  const key = `contact:${contactId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  console.log('[ZohoBooks] FETCH contact:', contactId);
  const data = await zbGet(`/contacts/${contactId}`);
  const contact = data.contact || null;
  if (contact) cacheSet(key, contact, TTL.contact);
  return contact;
}

async function getDealerByEmail(email) {
  const data = await zbGet('/contacts', { contact_type: 'customer', search_text: email });
  const contacts = data.contacts || [];
  const match = contacts.find(c =>
    c.email === email ||
    (c.contact_persons && c.contact_persons.some(p => p.email === email))
  );
  if (!match) return null;
  const fullData = await zbGet(`/contacts/${match.contact_id}`);
  const full = fullData.contact || match;
  console.log('[ZohoBooks] Custom fields for', full.contact_name, ':', JSON.stringify(full.custom_fields));
  return full;
}

async function getDealerOutstanding(contactId) {
  const contact = await getDealerById(contactId);
  if (!contact) return { outstanding: 0, unusedCredits: 0, currency: 'AED' };
  return {
    outstanding:   parseFloat(contact.outstanding_receivable_amount   || 0),
    unusedCredits: parseFloat(contact.unused_credits_receivable_amount || 0),
    currency:      contact.currency_code || 'AED',
  };
}

/**
 * Optimized for Vercel: fetch 3 key statuses instead of 6.
 * 'all' covers sent+overdue+paid. Draft fetched separately.
 * This reduces calls from 6 → 2, well within 10s limit.
 */
async function getInvoicesForDealer(contactId) {
  const key = `invoices:${contactId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  console.log('[ZohoBooks] FETCH invoices for:', contactId);

  // Fetch across key statuses in parallel — overdue fetched separately
  // as Zoho 'all' filter sometimes excludes overdue with customer_id filter
  const [allInvoices, draftInvoices, overdueInvoices] = await Promise.all([
    zbGet('/invoices', {
      customer_id: contactId,
      status: 'all',
      sort_column: 'date',
      sort_order: 'D',
      per_page: 200,
    }).then(d => d.invoices || []).catch(() => []),

    zbGet('/invoices', {
      customer_id: contactId,
      status: 'draft',
      sort_column: 'date',
      sort_order: 'D',
      per_page: 200,
    }).then(d => d.invoices || []).catch(() => []),

    zbGet('/invoices', {
      customer_id: contactId,
      status: 'overdue',
      sort_column: 'date',
      sort_order: 'D',
      per_page: 200,
    }).then(d => d.invoices || []).catch(() => []),
  ]);

  console.log('[ZohoBooks] Raw counts — all:', allInvoices.length,
    'draft:', draftInvoices.length, 'overdue:', overdueInvoices.length);

  // Merge and deduplicate
  const seen = new Set();
  const unique = [...allInvoices, ...draftInvoices, ...overdueInvoices].filter(inv => {
    if (seen.has(inv.invoice_id)) return false;
    seen.add(inv.invoice_id);
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  console.log('[ZohoBooks] Total unique invoices:', unique.length);

  cacheSet(key, unique, TTL.invoices);
  return unique;
}

async function getInvoiceDetails(invoiceId) {
  const data = await zbGet(`/invoices/${invoiceId}`);
  return data.invoice || null;
}

async function getPaymentsForDealer(contactId) {
  const key = `payments:${contactId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  console.log('[ZohoBooks] FETCH payments for:', contactId);
  try {
    const data = await zbGet('/customerpayments', {
      customer_id: contactId,
      sort_column: 'date',
      sort_order: 'D',
    });
    const payments = data.customerpayments || [];
    cacheSet(key, payments, TTL.payments);
    return payments;
  } catch (err) {
    console.error('[ZohoBooks] payments error:', err.message);
    return [];
  }
}

async function createSalesOrder(orderData) {
  const payload = {
    customer_id: orderData.contactId,
    date: new Date().toISOString().split('T')[0],
    notes: orderData.notes || 'Order placed via GLC Dealer Portal',
    line_items: orderData.lineItems.map(item => ({
      item_id: item.itemId, quantity: item.quantity,
      rate: item.rate, description: item.description || '',
    })),
  };
  const data = await zbPost('/salesorders', payload);
  invalidateDealer(orderData.contactId);
  return data.salesorder || null;
}

async function getSalesOrdersForDealer(contactId) {
  try {
    const data = await zbGet('/salesorders', {
      customer_id: contactId,
      sort_column: 'date',
      sort_order: 'D',
    });
    return data.salesorders || [];
  } catch (err) {
    console.error('[ZohoBooks] salesorders error:', err.message);
    return [];
  }
}

module.exports = {
  getAllDealers, getDealerById, getDealerByEmail,
  getDealerOutstanding, getInvoicesForDealer, getInvoiceDetails,
  getPaymentsForDealer, createSalesOrder, getSalesOrdersForDealer,
  invalidateDealer, clearAllCache,
};