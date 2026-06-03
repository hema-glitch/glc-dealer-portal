/**
 * orders.js — Route: /api/orders
 * Handles order placement and order history for dealers.
 */

const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const { createSalesOrder, getSalesOrdersForDealer } = require('../services/zohoBooks');
const { getAllProductsWithFOC } = require('../services/zohoInventory');

const router = express.Router();

function calculateFOCFromProducts(items, products, category = 'Standard') {
  const productById = new Map(products.map(product => [String(product.item_id), product]));

  return items.map((item) => {
    const product = productById.get(String(item.itemId));
    const quantity = Number(item.quantity) || 0;
    const rate = Number(item.rate ?? product?.rate ?? 0);
    const foc = product?.foc;

    let freeQty = 0;
    let scheme = null;
    const dealerCategory = String(category || 'Standard').toLowerCase();
    const focCategories = (foc?.categories || []).map(c => String(c).toLowerCase());

    if (
      foc?.active &&
      foc.slabBuy > 0 &&
      foc.slabFree > 0 &&
      (!focCategories.length || focCategories.includes(dealerCategory))
    ) {
      freeQty = Math.floor(quantity / foc.slabBuy) * foc.slabFree;
      if (freeQty > 0) scheme = foc.label || `Buy ${foc.slabBuy} Get ${foc.slabFree} Free`;
    }

    return {
      ...item,
      name: item.name || product?.name || '',
      quantity,
      rate,
      freeQty,
      scheme,
    };
  });
}

/**
 * GET /api/orders
 * Returns order history for the logged-in dealer.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { contactId } = req.dealer;
    const orders = await getSalesOrdersForDealer(contactId);

    const formatted = orders.map((o) => ({
      id: o.salesorder_id,
      number: o.salesorder_number,
      date: o.date,
      total: o.total,
      status: o.status,
      currency: o.currency_code,
    }));

    res.json({ success: true, orders: formatted });
  } catch (err) {
    console.error('[Orders] Fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

/**
 * POST /api/orders
 * Places a new order — pushed directly to Zoho Books as a Sales Order.
 * Body: { items: [{ itemId, name, quantity, rate }], notes }
 */
router.post('/', authMiddleware, async (req, res) => {
  const { items, notes } = req.body;
  const { contactId, category } = req.dealer;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }

  try {
    const products = await getAllProductsWithFOC();
    const cartWithFOC = calculateFOCFromProducts(items, products, category || 'Standard');

    // Build line items for Zoho Books
    const lineItems = cartWithFOC.map((item) => ({
      itemId: item.itemId,
      quantity: item.quantity,
      rate: item.rate,
      description: item.freeQty > 0
        ? `${item.scheme} — ${item.freeQty} units FREE added separately`
        : item.name,
    }));

    // If any FOC items, add them as free line items (rate = 0)
    cartWithFOC.forEach((item) => {
      if (item.freeQty > 0) {
        lineItems.push({
          itemId: item.itemId,
          quantity: item.freeQty,
          rate: 0,
          description: `FOC — ${item.scheme}`,
        });
      }
    });

    const salesOrder = await createSalesOrder({
      contactId,
      lineItems,
      notes: notes || 'Order placed via GLC Dealer Portal',
    });

    res.json({
      success: true,
      order: {
        id: salesOrder.salesorder_id,
        number: salesOrder.salesorder_number,
        status: salesOrder.status,
        total: salesOrder.total,
      },
      focApplied: cartWithFOC.filter((i) => i.freeQty > 0).map((i) => ({
        name: i.name,
        freeQty: i.freeQty,
        scheme: i.scheme,
      })),
    });

  } catch (err) {
    console.error('[Orders] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create order. Please try again.' });
  }
});

module.exports = router;
