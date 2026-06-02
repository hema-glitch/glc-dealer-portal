/**
 * zohoInventory.js
 * Zoho Inventory API interactions — products, stock levels, items.
 * Docs: https://www.zoho.com/inventory/api/v1/
 */

const axios = require('axios');
const { getAuthHeader } = require('./zohoAuth');

const BASE_URL = process.env.ZOHO_INVENTORY_URL;
const ORG_ID = process.env.ZOHO_ORG_ID;

async function invGet(endpoint, params = {}) {
  const auth = await getAuthHeader();
  const response = await axios.get(`${BASE_URL}${endpoint}`, {
    headers: { Authorization: auth },
    params: { organization_id: ORG_ID, ...params },
  });
  return response.data;
}

// ─── ITEMS / PRODUCTS ─────────────────────────────────────────────────────────

/**
 * Get all active products from Zoho Inventory.
 * Returns items with stock levels.
 */
async function getAllProducts() {
  const data = await invGet('/items', { status: 'active' });
  return data.items || [];
}

/**
 * Get a single product with full details including stock.
 */
async function getProductById(itemId) {
  const data = await invGet(`/items/${itemId}`);
  return data.item || null;
}

/**
 * Get products by group/category name.
 */
async function getProductsByCategory(categoryName) {
  const data = await invGet('/items', {
    status: 'active',
    category_name: categoryName,
  });
  return data.items || [];
}

/**
 * Get current stock level for a specific item.
 * Returns { itemId, name, stockOnHand, availableStock }
 */
async function getStockLevel(itemId) {
  const data = await invGet(`/items/${itemId}`);
  const item = data.item || {};
  return {
    itemId,
    name: item.name,
    stockOnHand: item.stock_on_hand || 0,
    availableStock: item.available_stock || 0,
    unit: item.unit || 'pcs',
  };
}

/**
 * Get stock levels for multiple items at once.
 * Returns a map: { itemId -> stockInfo }
 */
async function getBulkStockLevels(itemIds) {
  const results = {};
  // Zoho Inventory doesn't have bulk stock endpoint, so we batch sequentially
  for (const itemId of itemIds) {
    try {
      results[itemId] = await getStockLevel(itemId);
    } catch {
      results[itemId] = { itemId, stockOnHand: 0, availableStock: 0 };
    }
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
