/**
 * products.js — Route: /api/products
 * FOC data comes from Zoho Books item custom fields — no local config needed.
 */

const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const { getAllProductsWithFOC } = require('../services/zohoInventory');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const items = await getAllProductsWithFOC();

    const products = items.map(item => ({
      id:          item.item_id,
      name:        item.name,
      sku:         item.sku,
      rate:        item.rate,
      currency:    item.currency,
      unit:        item.unit,
      stock:       item.stock,
      inStock:     item.inStock,
      category:    item.category,
      foc:         item.foc,   // already parsed from Zoho custom fields
    }));

    res.json({ success: true, products, total: products.length });
  } catch (err) {
    console.error('[Products] Error:', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

module.exports = router;