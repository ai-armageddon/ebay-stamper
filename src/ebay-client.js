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
  LISTINGS_CACHE_MS = "90000",
  EBAY_MAX_RESULTS = "150",
  EBAY_MAX_PAGES = "5",
} = process.env;
const DEFAULT_LISTINGS_CACHE_MS = Number(LISTINGS_CACHE_MS) || 90000;
const DEFAULT_MAX_RESULTS = Number(EBAY_MAX_RESULTS) || 150;
const DEFAULT_MAX_PAGES = Number(EBAY_MAX_PAGES) || 5;
const MAX_PAGE_SIZE = 50;
const MAX_ALLOWED_RESULTS = MAX_PAGE_SIZE * DEFAULT_MAX_PAGES;
const listingsCache = new Map();

function normalizeBrowseItem(item) {
  const shippingOptions = Array.isArray(item.shippingOptions) ? item.shippingOptions : [];
  const pricedShipping = shippingOptions
    .map((option) =>
      Number(
        option &&
          option.shippingCost &&
          option.shippingCost.value
          ? option.shippingCost.value
          : 0
      )
    )
    .filter((cost) => Number.isFinite(cost) && cost >= 0);
  const shippingCost = pricedShipping.length > 0 ? Math.min(...pricedShipping) : 0;

  return {
    id: item.itemId || item.legacyItemId || `ebay-${Math.random()}`,
    title: item.title || "Untitled listing",
    price: Number(item.price && item.price.value ? item.price.value : 0),
    shippingCost,
    totalCost: Number(item.price && item.price.value ? item.price.value : 0) + shippingCost,
    currency: item.price && item.price.currency ? item.price.currency : "USD",
    condition: item.condition || "Unknown",
    seller: item.seller && item.seller.username ? item.seller.username : "unknown_seller",
    sellerFeedbackPercentage:
      item.seller && item.seller.feedbackPercentage
        ? Number(item.seller.feedbackPercentage)
        : null,
    sellerFeedbackScore:
      item.seller && item.seller.feedbackScore
        ? Number(item.seller.feedbackScore)
        : null,
    sellerTopRated:
      item.seller && typeof item.seller.topRatedSeller === "boolean"
        ? item.seller.topRatedSeller
        : null,
    sellerAccountType:
      item.seller && item.seller.sellerAccountType ? item.seller.sellerAccountType : null,
    image: item.image && item.image.imageUrl ? item.image.imageUrl : "",
    itemWebUrl: item.itemWebUrl || "",
    description: item.shortDescription || item.subtitle || "",
    listedAt:
      item.itemCreationDate || item.itemOriginDate || new Date().toISOString(),
  };
}

async function fetchToken(options = {}) {
  const { allowPrefetched = true } = options;

  if (allowPrefetched && EBAY_TOKEN) {
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

function sanitizePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.round(parsed);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

async function searchItems(query, token, options = {}) {
  const { limit = MAX_PAGE_SIZE, offset = 0 } = options;
  const searchUrl = `${EBAY_API_BASE_URL}/buy/browse/v1/item_summary/search`;
  const response = await axios.get(searchUrl, {
    params: {
      q: query,
      limit,
      offset,
      sort: "best_match",
      category_ids: "260",
      filter: "buyingOptions:{FIXED_PRICE}",
    },
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      Accept: "application/json",
    },
    timeout: 12000,
  });
  return response;
}

async function runSearchWithTokenRetry(query, tokenState, options = {}) {
  let response;
  try {
    response = await searchItems(query, tokenState.token, options);
  } catch (error) {
    const isUnauthorized = error.response && error.response.status === 401;
    const canMintFreshToken = Boolean(EBAY_APP_ID && EBAY_CERT_ID);
    if (isUnauthorized && canMintFreshToken) {
      tokenState.token = await fetchToken({ allowPrefetched: false });
      response = await searchItems(query, tokenState.token, options);
    } else if (isUnauthorized) {
      throw new Error(
        "eBay returned 401. Your EBAY_TOKEN is likely expired. Provide a fresh EBAY_TOKEN or set EBAY_APP_ID and EBAY_CERT_ID."
      );
    } else {
      throw error;
    }
  }
  return response;
}

async function fetchFromEbay(query, options = {}) {
  const maxResults = sanitizePositiveInt(
    options.maxResults,
    DEFAULT_MAX_RESULTS,
    { min: 1, max: MAX_ALLOWED_RESULTS }
  );
  const maxPages = sanitizePositiveInt(
    options.maxPages,
    DEFAULT_MAX_PAGES,
    { min: 1, max: 10 }
  );
  const pageSize = Math.min(MAX_PAGE_SIZE, maxResults);
  const pagesBudget = Math.max(1, Math.min(maxPages, Math.ceil(maxResults / pageSize)));

  let token = await fetchToken({ allowPrefetched: true });
  const tokenState = { token };
  let totalMatchesEstimate = 0;
  let apiCallsUsed = 0;
  const rawItems = [];
  const seenIds = new Set();

  for (let page = 0; page < pagesBudget; page += 1) {
    const offset = page * pageSize;
    const remaining = maxResults - rawItems.length;
    if (remaining <= 0) {
      break;
    }

    const response = await runSearchWithTokenRetry(query, tokenState, {
      limit: Math.min(pageSize, remaining),
      offset,
    });
    apiCallsUsed += 1;

    const items =
      response.data && Array.isArray(response.data.itemSummaries)
        ? response.data.itemSummaries
        : [];
    const responseTotal = Number(
      response.data && response.data.total ? response.data.total : items.length
    );
    if (Number.isFinite(responseTotal) && responseTotal > 0) {
      totalMatchesEstimate = Math.max(totalMatchesEstimate, responseTotal);
    }

    for (const item of items) {
      const uniqueId = item && (item.itemId || item.legacyItemId);
      if (uniqueId && seenIds.has(uniqueId)) {
        continue;
      }
      if (uniqueId) {
        seenIds.add(uniqueId);
      }
      rawItems.push(item);
      if (rawItems.length >= maxResults) {
        break;
      }
    }

    if (items.length < Math.min(pageSize, remaining)) {
      break;
    }
    if (totalMatchesEstimate > 0 && rawItems.length >= totalMatchesEstimate) {
      break;
    }
  }

  const listings = rawItems.map(normalizeBrowseItem).slice(0, maxResults);

  return {
    listings,
    fetchedCount: listings.length,
    totalMatchesEstimate: Number.isNaN(totalMatchesEstimate)
      ? listings.length
      : totalMatchesEstimate || listings.length,
    apiCallsUsed,
    maxResultsRequested: maxResults,
  };
}

async function getListings(options = {}) {
  const {
    query = "usps forever stamps",
    useMock = true,
    forceRefresh = false,
    cacheTtlMs = DEFAULT_LISTINGS_CACHE_MS,
    maxResults = DEFAULT_MAX_RESULTS,
    maxPages = DEFAULT_MAX_PAGES,
  } = options;
  const requestedMaxResults = sanitizePositiveInt(maxResults, DEFAULT_MAX_RESULTS, {
    min: 1,
    max: MAX_ALLOWED_RESULTS,
  });
  const requestedMaxPages = sanitizePositiveInt(maxPages, DEFAULT_MAX_PAGES, {
    min: 1,
    max: 10,
  });
  const cacheKey = `${String(query || "").trim().toLowerCase()}|${requestedMaxResults}|${requestedMaxPages}`;
  const now = Date.now();
  const cached = listingsCache.get(cacheKey);

  if (
    !forceRefresh &&
    cached &&
    now - cached.cachedAt <= Number(cacheTtlMs || DEFAULT_LISTINGS_CACHE_MS)
  ) {
    const cachedStats = cached.payload && cached.payload.stats ? cached.payload.stats : {};
    return {
      ...cached.payload,
      fetchMode: "cache",
      cacheAgeMs: now - cached.cachedAt,
      stats: {
        ...cachedStats,
        apiCallsUsed: 0,
      },
    };
  }

  try {
    const ebayResult = await fetchFromEbay(query, {
      maxResults: requestedMaxResults,
      maxPages: requestedMaxPages,
    });
    const listings = ebayResult.listings;
    if (listings.length === 0 && useMock) {
      return {
        source: "mock-empty-ebay",
        fetchMode: "mock",
        cacheAgeMs: 0,
        listings: mockListings,
        stats: {
          comparedCount: mockListings.length,
          fetchedCount: 0,
          totalMatchesEstimate: ebayResult.totalMatchesEstimate,
          apiCallsUsed: ebayResult.apiCallsUsed,
          maxResultsRequested: requestedMaxResults,
        },
      };
    }
    const payload = {
      source: "ebay",
      fetchMode: "api",
      cacheAgeMs: 0,
      listings,
      stats: {
        comparedCount: listings.length,
        fetchedCount: ebayResult.fetchedCount,
        totalMatchesEstimate: ebayResult.totalMatchesEstimate,
        apiCallsUsed: ebayResult.apiCallsUsed,
        maxResultsRequested: ebayResult.maxResultsRequested,
      },
    };
    listingsCache.set(cacheKey, {
      cachedAt: now,
      payload,
    });
    return payload;
  } catch (error) {
    if (!useMock) {
      throw error;
    }
    return {
      source: "mock-fallback",
      fetchMode: "mock",
      cacheAgeMs: 0,
      listings: mockListings,
      stats: {
        comparedCount: mockListings.length,
        fetchedCount: 0,
        totalMatchesEstimate: mockListings.length,
        apiCallsUsed: 0,
        maxResultsRequested: requestedMaxResults,
      },
    };
  }
}

module.exports = {
  getListings,
  normalizeBrowseItem,
};
