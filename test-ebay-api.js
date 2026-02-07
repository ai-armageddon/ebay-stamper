// test-ebay-api.js
require('dotenv').config();
const axios = require('axios');

const {
  EBAY_APP_ID,
  EBAY_CERT_ID,
  EBAY_TOKEN_URL,
  EBAY_API_BASE_URL,
  EBAY_SCOPES,
} = process.env;

/**
 * Fetch a client credentials token from eBay.
 */
async function fetchToken() {
  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    throw new Error('Missing EBAY_APP_ID or EBAY_CERT_ID in .env');
  }

  const authString = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');

  const tokenResponse = await axios.post(
    EBAY_TOKEN_URL,
    'grant_type=client_credentials&scope=' + encodeURIComponent(EBAY_SCOPES),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authString}`,
      },
    }
  );

  const token = tokenResponse.data.access_token;
  // Avoid dumping full secrets to logs; just show the start for confirmation.
  console.log('Received token (truncated):', token ? `${token.slice(0, 10)}...` : 'none');
  return token;
}

/**
 * Run a small Browse API search to prove the token works.
 */
async function runSmokeTest(token) {
  const searchUrl = `${EBAY_API_BASE_URL}/buy/browse/v1/item_summary/search`;

  const response = await axios.get(searchUrl, {
    params: { q: 'stamps', limit: 3 },
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      Accept: 'application/json',
    },
  });

  const { itemSummaries = [] } = response.data || {};
  console.log(`Found ${itemSummaries.length} items:`);
  itemSummaries.forEach((item, idx) => {
    console.log(
      `${idx + 1}. ${item.title} — ${item.price?.value} ${item.price?.currency}`
    );
  });
}

async function main() {
  try {
    const token = await fetchToken();
    await runSmokeTest(token);
  } catch (err) {
    if (err.response) {
      console.error('API error:', err.response.status, err.response.data);
    } else {
      console.error('Unexpected error:', err.message);
    }
    process.exitCode = 1;
  }
}

main();
