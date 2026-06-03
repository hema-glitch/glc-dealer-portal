/**
 * Zoho cache invalidation webhook.
 *
 * Configure Zoho Flow/Books/Inventory to POST here when contacts, invoices,
 * payments, sales orders, or items change. The app then refreshes data only
 * after a real upstream change instead of polling Zoho every session.
 */

const crypto = require('crypto');
const express = require('express');
const {
  clearAllCache,
  invalidateContactData,
  invalidateDealerData,
} = require('../services/zohoBooks');
const { invalidateProductCache } = require('../services/zohoInventory');

const router = express.Router();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function pickContactId(body) {
  return body.contact_id
    || body.customer_id
    || body.customerId
    || body?.data?.contact_id
    || body?.data?.customer_id
    || body?.contact?.contact_id
    || body?.customer?.contact_id
    || body?.invoice?.customer_id
    || body?.payment?.customer_id
    || body?.salesorder?.customer_id;
}

function pickItemId(body) {
  return body.item_id
    || body.itemId
    || body?.data?.item_id
    || body?.item?.item_id
    || body?.product?.item_id;
}

function pickModule(body) {
  return normalize(
    body.module
      || body.module_name
      || body.entity
      || body.event
      || body.resource
      || body.action
      || body?.data?.module
      || body?.data?.entity
  );
}

router.post('/webhook', async (req, res) => {
  try {
    const expectedSecret = process.env.ZOHO_WEBHOOK_SECRET;
    if (!expectedSecret) {
      return res.status(503).json({ error: 'ZOHO_WEBHOOK_SECRET is not configured' });
    }

    const suppliedSecret = req.get('x-zoho-webhook-secret')
      || req.get('x-webhook-secret')
      || req.query.secret
      || req.body?.secret;

    if (!safeEqual(suppliedSecret, expectedSecret)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const moduleName = pickModule(req.body);
    const contactId = pickContactId(req.body);
    const itemId = pickItemId(req.body);
    const invalidated = [];

    if (moduleName.includes('contact') || moduleName.includes('customer') || moduleName.includes('dealer')) {
      await invalidateContactData(contactId);
      invalidated.push('contacts');
    }

    if (
      moduleName.includes('invoice') ||
      moduleName.includes('payment') ||
      moduleName.includes('salesorder') ||
      moduleName.includes('sales_order')
    ) {
      await invalidateDealerData(contactId);
      invalidated.push(`dealer:${contactId || 'unknown'}`);
    }

    if (
      moduleName.includes('item') ||
      moduleName.includes('product') ||
      moduleName.includes('inventory') ||
      moduleName.includes('stock')
    ) {
      await invalidateProductCache(itemId);
      invalidated.push(`products:${itemId || 'all'}`);
    }

    if (!invalidated.length && contactId) {
      await invalidateDealerData(contactId);
      invalidated.push(`dealer:${contactId}`);
    }

    if (!invalidated.length && itemId) {
      await invalidateProductCache(itemId);
      invalidated.push(`products:${itemId}`);
    }

    if (!invalidated.length) {
      await clearAllCache();
      invalidated.push('all');
    }

    res.json({ success: true, invalidated });
  } catch (err) {
    console.error('[ZohoWebhook] error:', err.message);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;
