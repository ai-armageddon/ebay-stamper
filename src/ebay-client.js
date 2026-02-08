const axios = require("axios");
const { mockListings } = require("./mock-listings");

const ENV = (process.env.EBAY_ENV || "SANDBOX").toUpperCase();
const DEFAULT_API_BASE =
  ENV === "PRODUCTION" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com";
const DEFAULT_TOKEN_URL =
  ENV === "PRODUCTION"
    ? "https://api.ebay.com/identity/v1/oauth2/token"
    : "https://api.sandbox.ebay.com/identity/v1/oauth2/token";

const {
  EBAY_APP_ID,
  EBAY_CERT_ID,
  EBAY_TOKEN, // optional pre-fetched OAuth token
  EBAY_TOKEN_URL = DEFAULT_TOKEN_URL,
  EBAY_API_BASE_URL = DEFAULT_API_BASE,
  EBAY_SCOPES = "https://api.ebay.com/oauth/api_scope",
} = process.env;

function normalizeBrowseItem(item) {
  return {
    id: item.itemId || item.legacyItemId || `ebay-${Math.random()}`,
    title: item.title || "Untitled listing",
    price: Number(item.price && item.price.value ? item.price.value : 0),
    currency: item.price && item.price.currency ? item.price.currency : "USD",
    condition: item.condition || "Unknown",
    seller:
      item.seller &&
      (item.seller.username || item.seller.feedbackPercentage || item.seller)
        ? item.seller.username || String(item.seller)
        : "unknown_seller",
    image: item.image && item.image.imageUrl ? item.image.imageUrl : "",
    itemWebUrl: item.itemWebUrl || "",
    listedAt:
      item.itemCreationDate || item.itemOriginDate || new Date().toISOString(),
  };
}

async function fetchToken() {
  if (EBAY_TOKEN) {
    return EBAY_TOKEN;
  }

  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    throw new Error("Missing EBAY_APP_ID or EBAY_CERT_ID in .env");
  }

  const authString = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString(
    "base64"
  );

  const response = await axios.post(
    EBAY_TOKEN_URL,
    "grant_type=client_credentials&scope=" + encodeURIComponent(EBAY_SCOPES),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${authString}`,
      },
      timeout: 12000,
    }
  );
  return response.data.access_token;
}

async function fetchFromEbay(query) {
  const token = await fetchToken();
  const searchUrl = `${EBAY_API_BASE_URL}/buy/browse/v1/item_summary/search`;
  const response = await axios.get(searchUrl, {
    params: {
      q: query,
      limit: 30,
      sort: "newlyListed",
      category_ids: "260",
    },
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      Accept: "application/json",
    },
    timeout: 12000,
  });

  const items = response.data && response.data.itemSummaries
    ? response.data.itemSummaries
    : [];
  return items.map(normalizeBrowseItem);
}

async function getListings(options = {}) {
  const { query = "usps forever stamps", useMock = true } = options;
  try {
    const listings = await fetchFromEbay(query);
    if (listings.length === 0 && useMock) {
      return { source: "mock-empty-ebay", listings: mockListings };
    }
    return { source: "ebay", listings };
  } catch (error) {
    if (!useMock) {
      throw error;
    }
    return { source: "mock-fallback", listings: mockListings };
  }
}

module.exports = {
  getListings,
  normalizeBrowseItem,
};
