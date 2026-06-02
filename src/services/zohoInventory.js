/**
 * zohoInventory.js
 * Falls back to Zoho Books /items endpoint if Inventory URL not configured.
 * This ensures products work on Vercel without needing a separate Inventory setup.
 */

const axios = require('axios');
const { getAuthHeader } = require('./zohoAuth');

// Use Inventory URL if set, otherwise fall back to Books URL
const BASE_URL = process.env.ZOHO_INVENTORY_URL || process.env.ZOHO_BOOKS_URL;
const ORG_ID   = process.env.ZOHO_ORG_ID;

async function invGet(endpoint, params = {}) {
  const auth = await getAuthHeader();
  try {
    const response = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: { Authorization: auth },
      params:  { organization_id: ORG_ID, ...params },
      timeout: 7000,
    });
    return response.data;
  } catch (err) {
    console.error(`[ZohoInventory] GET ${endpoint} failed:`, err.response?.data || err.message);
    throw err;
  }
}

async function getAllProducts() {
  // Try Inventory endpoint first, fall back to Books items
  try {
    const data = await invGet('/items', { status: 'active' });
    // Inventory returns data.items, Books also returns data.items
    return data.items || [];
  } catch (err) {
    console.error('[ZohoInventory] getAllProducts error:', err.message);
    return [];
  }
}

async function getProductById(itemId) {
  try {
    const data = await invGet(`/items/${itemId}`);
    return data.item || null;
  } catch (err) {
    console.error('[ZohoInventory] getProductById error:', err.message);
    return null;
  }
}

async function getProductsByCategory(categoryName) {
  try {
    const data = await invGet('/items', { status: 'active', category_name: categoryName });
    return data.items || [];
  } catch (err) {
    return [];
  }
}

async function getStockLevel(itemId) {
  try {
    const data = await invGet(`/items/${itemId}`);
    const item = data.item || {};
    return {
      itemId,
      name:           item.name,
      stockOnHand:    item.stock_on_hand    || 0,
      availableStock: item.available_stock  || 0,
      unit:           item.unit             || 'pcs',
    };
  } catch (err) {
    return { itemId, stockOnHand: 0, availableStock: 0 };
  }
}

async function getBulkStockLevels(itemIds) {
  const results = {};
  for (const itemId of itemIds) {
    results[itemId] = await getStockLevel(itemId);
  }
  return results;
}

module.exports = {
  getAllProducts,
  getProductById,
  getProductsByCategory,
  getStockLevel,
  getBulkStockLevels,
};