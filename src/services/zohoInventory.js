/**
 * zohoInventory.js
 * Products from Zoho Books/Inventory with FOC scheme data from item custom fields.
 *
 * FOC is stored directly on Zoho Books items as custom fields:
 *   cf_foc_active   : true/false
 *   cf_foc_buy_qty  : number (e.g. 10)
 *   cf_foc_free_qty : number (e.g. 2)
 *   cf_foc_category : "All" | "Standard" | "Premium"
 *
 * One-time setup in Zoho Books:
 *   Settings → Items → Custom Fields → Add the 4 fields above
 */

const axios = require('axios');
const { getAuthHeader } = require('./zohoAuth');
const { remember, deleteCache } = require('./cacheStore');

const BASE_URL = process.env.ZOHO_INVENTORY_URL || process.env.ZOHO_BOOKS_URL || 'https://www.zohoapis.com/books/v3';
const BOOKS_URL = process.env.ZOHO_BOOKS_URL || 'https://www.zohoapis.com/books/v3';
const ORG_ID = process.env.ZOHO_ORG_ID;

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PRODUCT_TTL = envMs('CACHE_TTL_PRODUCTS_MS', 6 * 60 * 60 * 1000);

// ─── Helper: extract custom field value ───────────────────────────────────────
function getCF(customFields, apiName, label) {
  if (!Array.isArray(customFields)) return null;
  const f = customFields.find(f =>
    f.api_name === apiName ||
    f.label    === label   ||
    f.api_name === `cf_${label?.toLowerCase().replace(/\s+/g, '_')}`
  );
  if (!f) return null;
  return f.value ?? f.cf_value ?? null;
}

// ─── Parse FOC custom fields from a Zoho item ─────────────────────────────────
function parseFOC(item) {
  // First try direct fields from item list API
  let active = item.cf_foc_active;
  let buyQty = item.cf_foc_buy_qty;
  let freeQty = item.cf_foc_free_qty;
  let catRaw = item.cf_foc_category;

  // Fallback to custom_fields array
  if (
    active === undefined &&
    buyQty === undefined &&
    freeQty === undefined
  ) {
    const cf = item.custom_fields || [];

    active =
      getCF(cf, 'cf_foc_active', 'FOC Active') ||
      getCF(cf, 'cf_foc_enabled', 'FOC Enabled');

    buyQty =
      getCF(cf, 'cf_foc_buy_qty', 'FOC Buy Qty') ||
      getCF(cf, 'cf_foc_buy', 'FOC Buy');

    freeQty =
      getCF(cf, 'cf_foc_free_qty', 'FOC Free Qty') ||
      getCF(cf, 'cf_foc_free', 'FOC Free');

    catRaw =
      getCF(cf, 'cf_foc_category', 'FOC Category') ||
      'All';
  }

  const isActive =
    active === true ||
    active === 'true' ||
    active === 'True' ||
    active === '1' ||
    active === 1;

  const slabBuy = parseInt(buyQty || 0, 10);
  const slabFree = parseInt(freeQty || 0, 10);

  if (!isActive || slabBuy <= 0 || slabFree <= 0) {
    return { active: false };
  }

  const catStr = String(catRaw || 'All').toLowerCase();

  let categories = ['Standard', 'Premium'];

  if (catStr === 'standard') categories = ['Standard'];
  if (catStr === 'premium') categories = ['Premium'];

  return {
    active: true,
    slabBuy,
    slabFree,
    categories,
    label: `Buy ${slabBuy} Get ${slabFree} Free`,
    categoryLabel:
      catStr === 'all'
        ? 'All Dealers'
        : catRaw
  };
}

// ─── GET all products ─────────────────────────────────────────────────────────
async function getAllProducts() {
  return remember('products_raw', PRODUCT_TTL, async () => {
    const auth = await getAuthHeader();
    try {
      const response = await axios.get(`${BASE_URL}/items`, {
        headers: { Authorization: auth },
        params:  { organization_id: ORG_ID, status: 'active' },
        timeout: 15000,
      });
      return response.data?.items || [];
    } catch (err) {
      console.error('[ZohoInventory] getAllProducts error:', err.response?.data || err.message);
      return [];
    }
  });
}

// ─── GET all products with FOC parsed ────────────────────────────────────────
async function getAllProductsWithFOC() {
  return remember('products_with_foc', PRODUCT_TTL, async () => {
    const items = await getAllProducts();
    return items.map(item => ({
      item_id:        item.item_id,
      name:           item.name,
      sku:            item.sku            || '',
      rate:           item.rate           || 0,
      currency:       item.currency_code  || 'AED',
      unit:           item.unit           || 'pcs',
      stock:          item.available_stock || item.stock_on_hand || 0,
      inStock:        (item.available_stock || item.stock_on_hand || 0) > 0,
      category:       item.category_name  || 'General',
      custom_fields:  item.custom_fields  || [],
      foc:            parseFOC(item),
    }));
  });
}

// ─── UPDATE item FOC custom fields in Zoho Books ─────────────────────────────
// This is what admin calls when they configure FOC in the portal.
// Writes directly to the Zoho item — no /tmp, no env vars.
async function updateItemFOC(itemId, { active, slabBuy, slabFree, category }) {
  const auth = await getAuthHeader();

  // Build custom fields payload
  // Zoho Books requires the custom field label or api_name
  const customFields = [
    { label: 'FOC Active',   value: active ? 'true' : 'false' },
    { label: 'FOC Buy Qty',  value: active ? String(slabBuy)  : '0' },
    { label: 'FOC Free Qty', value: active ? String(slabFree) : '0' },
    { label: 'FOC Category', value: active ? (category || 'All') : 'All' },
  ];

  let response;
  try {
    response = await axios.put(
      `${BOOKS_URL}/items/${itemId}`,
      { custom_fields: customFields },
      {
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        params:  { organization_id: ORG_ID },
        timeout: 15000,
      }
    );
  } catch (err) {
    const details = err.response?.data || err.message;
    const e = new Error(`Zoho item update failed with HTTP ${err.response?.status || 'error'}: ${JSON.stringify(details)}`);
    e.status = err.response?.status || 502;
    e.details = details;
    throw e;
  }

  if (response.data?.code !== 0) {
    throw new Error(`Zoho error: ${response.data?.message}`);
  }
  await invalidateProductCache(itemId);
  return response.data?.item;
}

// ─── GET single product ───────────────────────────────────────────────────────
async function getProductById(itemId) {
  return remember(`product_${itemId}`, PRODUCT_TTL, async () => {
    const auth = await getAuthHeader();
    try {
      const { data } = await axios.get(`${BASE_URL}/items/${itemId}`, {
        headers: { Authorization: auth },
        params:  { organization_id: ORG_ID },
        timeout: 10000,
      });
      return data?.item || null;
    } catch (err) {
      return null;
    }
  });
}

async function invalidateProductCache(itemId) {
  await Promise.all([
    deleteCache('products_raw'),
    deleteCache('products_with_foc'),
    itemId ? deleteCache(`product_${itemId}`) : Promise.resolve(),
  ]);
}

module.exports = {
  getAllProducts,
  getAllProductsWithFOC,
  updateItemFOC,
  getProductById,
  invalidateProductCache,
  parseFOC,
};
