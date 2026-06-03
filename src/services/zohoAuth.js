/**
 * zohoAuth.js — Zoho OAuth token management
 *
 * IMPORTANT: Zoho OAuth /token endpoint requires credentials as
 * URL query parameters (null body + params object in axios),
 * NOT as a request body / URLSearchParams string.
 */

const axios = require('axios');

const ZOHO_ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';

let tokenCache = { access_token: null, expires_at: 0 };

async function getAccessToken() {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache.access_token && now < tokenCache.expires_at - 60000) {
    return tokenCache.access_token;
  }

  console.log('[ZohoAuth] Refreshing access token...');

  // Validate env vars are present before attempting
  if (!process.env.ZOHO_REFRESH_TOKEN) throw new Error('[ZohoAuth] ZOHO_REFRESH_TOKEN is not set');
  if (!process.env.ZOHO_CLIENT_ID)     throw new Error('[ZohoAuth] ZOHO_CLIENT_ID is not set');
  if (!process.env.ZOHO_CLIENT_SECRET) throw new Error('[ZohoAuth] ZOHO_CLIENT_SECRET is not set');

  let response;
  try {
    // Zoho requires params as QUERY STRING — null body + params config object
    response = await axios.post(
      `${ZOHO_ACCOUNTS}/oauth/v2/token`,
      null,
      {
        params: {
          refresh_token: process.env.ZOHO_REFRESH_TOKEN,
          client_id:     process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          grant_type:    'refresh_token',
        },
      }
    );
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('[ZohoAuth] Token refresh HTTP error:', JSON.stringify(details));
    const e = new Error(`Zoho OAuth token refresh failed: ${JSON.stringify(details)}`);
    e.status = err.response?.status || 502;
    throw e;
  }

  const { access_token, expires_in, error } = response.data;

  if (error) {
    console.error('[ZohoAuth] Zoho returned error:', response.data);
    throw new Error(`Zoho OAuth error: ${error} — ${response.data.error_description || ''}`);
  }

  if (!access_token) {
    console.error('[ZohoAuth] No access_token in response:', response.data);
    throw new Error('No access_token in Zoho response: ' + JSON.stringify(response.data));
  }

  tokenCache = { access_token, expires_at: now + (expires_in || 3600) * 1000 };
  console.log('[ZohoAuth] Token refreshed successfully. Expires in', expires_in, 'seconds.');
  return access_token;
}

async function getAuthHeader() {
  const token = await getAccessToken();
  return `Zoho-oauthtoken ${token}`;
}

module.exports = { getAccessToken, getAuthHeader };