/**
 * zohoAuth.js — Zoho OAuth token management
 * Uses ZOHO_ACCOUNTS_URL env var with hardcoded fallback.
 * If env var is missing, defaults to https://accounts.zoho.com (works for UAE/global).
 */

const axios = require('axios');

// Hardcoded fallback — works for all global Zoho orgs including UAE
const ZOHO_ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';

let tokenCache = { access_token: null, expires_at: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expires_at - 60000) {
    return tokenCache.access_token;
  }

  console.log('[ZohoAuth] Refreshing access token...');

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const response = await axios.post(
    `${ZOHO_ACCOUNTS}/oauth/v2/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, expires_in } = response.data;
  if (!access_token) throw new Error('No access_token in Zoho response: ' + JSON.stringify(response.data));

  tokenCache = { access_token, expires_at: now + (expires_in || 3600) * 1000 };
  console.log('[ZohoAuth] Token refreshed. Expires in', expires_in, 'seconds.');
  return access_token;
}

async function getAuthHeader() {
  const token = await getAccessToken();
  return `Zoho-oauthtoken ${token}`;
}

module.exports = { getAccessToken, getAuthHeader };