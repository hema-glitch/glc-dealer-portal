/**
 * products.js — Route: /api/products
 * Returns product catalog from Zoho Inventory with stock levels and FOC info.
 */

const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const { getAllProducts } = require('../services/zohoInventory');
const { FOC_CONFIG } = require('../services/schemeEngine');

const router = express.Router();

/**
 * GET /api/products
 * Returns all active products with stock and scheme info.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const items = await getAllProducts();

    const products = items.map((item) => {
      const focScheme = FOC_CONFIG[item.item_id];
      return {
        id: item.item_id,
        name: item.name,
        description: item.description || '',
        sku: item.sku || '',
        rate: item.rate || 0,
        currency: item.currency_code || 'AED',
        unit: item.unit || 'pcs',
        stock: item.available_stock || item.stock_on_hand || 0,
        inStock: (item.available_stock || item.stock_on_hand || 0) > 0,
        category: item.category_name || 'General',
        imageUrl: item.image_document_id ? `/api/products/${item.item_id}/image` : null,
        foc: focScheme
          ? {
              active: true,
              slabBuy: focScheme.slabBuy,
              slabFree: focScheme.slabFree,
              label: `Buy ${focScheme.slabBuy} Get ${focScheme.slabFree} Free`,
            }
          : { active: false },
      };
    });

    res.json({ success: true, products, total: products.length });
  } catch (err) {
    console.error('[Products] Error:', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

module.exports = router;
