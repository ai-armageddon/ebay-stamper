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
  LISTINGS_BACKGROUND_REFRESH_MS = "240000",
  EBAY_MAX_RESULTS = "150",
  EBAY_MAX_PAGES = "10",
  EBAY_PROGRESSIVE_STEP = "100",
  EBAY_PROGRESSIVE_MAX_RESULTS = "600",
} = process.env;
const MAX_PAGE_SIZE = 50;
const ABSOLUTE_MAX_PAGES = 20;
const MAX_ALLOWED_RESULTS = MAX_PAGE_SIZE * ABSOLUTE_MAX_PAGES;
const DEFAULT_LISTINGS_CACHE_MS = Math.max(0, Number(LISTINGS_CACHE_MS) || 90000);
const DEFAULT_BACKGROUND_REFRESH_MS = Math.max(
  60000,
  Number(LISTINGS_BACKGROUND_REFRESH_MS) || 240000
);
const DEFAULT_MAX_RESULTS = Math.min(
  MAX_ALLOWED_RESULTS,
  Math.max(1, Number(EBAY_MAX_RESULTS) || 150)
);
const DEFAULT_MAX_PAGES = Math.min(
  ABSOLUTE_MAX_PAGES,
  Math.max(1, Number(EBAY_MAX_PAGES) || 10)
);
const DEFAULT_PROGRESSIVE_STEP = Math.min(
  250,
  Math.max(25, Number(EBAY_PROGRESSIVE_STEP) || 100)
);
const DEFAULT_PROGRESSIVE_MAX_RESULTS = Math.max(
  DEFAULT_MAX_RESULTS,
  Math.min(MAX_ALLOWED_RESULTS, Number(EBAY_PROGRESSIVE_MAX_RESULTS) || 600)
);
const listingsCache = new Map();
const listingsRefreshJobs = new Map();

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
  const descriptionParts = [
    item && item.shortDescription ? item.shortDescription : "",
    item && item.subtitle ? item.subtitle : "",
  ].filter((part) => String(part || "").trim().length > 0);

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
    description: descriptionParts.join(" | "),
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
    { min: 1, max: ABSOLUTE_MAX_PAGES }
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

function normalizeQuery(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || "usps forever stamps";
}

function buildMockResponse({
  source,
  requestedMaxResults,
  totalMatchesEstimate = mockListings.length,
  apiCallsUsed = 0,
} = {}) {
  const limit = sanitizePositiveInt(requestedMaxResults, DEFAULT_MAX_RESULTS, {
    min: 1,
    max: MAX_ALLOWED_RESULTS,
  });
  const listings = mockListings.slice(0, limit);
  return {
    source,
    fetchMode: "mock",
    cacheAgeMs: 0,
    listings,
    stats: {
      comparedCount: listings.length,
      fetchedCount: 0,
      totalMatchesEstimate,
      apiCallsUsed,
      maxResultsRequested: limit,
      crawlDepth: listings.length,
      crawlCap: DEFAULT_PROGRESSIVE_MAX_RESULTS,
      progressiveStep: DEFAULT_PROGRESSIVE_STEP,
      lastFetchReason: "mock",
    },
  };
}

function buildListingsResponse(cacheEntry, options = {}) {
  const {
    requestedMaxResults = DEFAULT_MAX_RESULTS,
    fetchMode = "cache",
    cacheAgeMs = 0,
    apiCallsUsed = 0,
    fetchedCount = 0,
  } = options;
  const limit = sanitizePositiveInt(requestedMaxResults, DEFAULT_MAX_RESULTS, {
    min: 1,
    max: MAX_ALLOWED_RESULTS,
  });
  const listings = cacheEntry.listings.slice(0, limit);

  return {
    source: cacheEntry.source || "ebay",
    fetchMode,
    cacheAgeMs: Math.max(0, Math.round(Number(cacheAgeMs || 0))),
    listings,
    stats: {
      comparedCount: listings.length,
      fetchedCount: Math.max(0, Math.round(Number(fetchedCount || 0))),
      totalMatchesEstimate: Number(cacheEntry.totalMatchesEstimate || listings.length),
      apiCallsUsed: Math.max(0, Math.round(Number(apiCallsUsed || 0))),
      maxResultsRequested: limit,
      crawlDepth: cacheEntry.listings.length,
      crawlCap: Math.max(DEFAULT_PROGRESSIVE_MAX_RESULTS, limit),
      progressiveStep: DEFAULT_PROGRESSIVE_STEP,
      lastFetchReason: cacheEntry.lastFetchReason || null,
    },
  };
}

function computeFetchTargetResults({
  existingDepth = 0,
  requestedMaxResults = DEFAULT_MAX_RESULTS,
  reason = "initial",
} = {}) {
  const baseline = Math.max(DEFAULT_MAX_RESULTS, requestedMaxResults);
  const dynamicCap = Math.max(DEFAULT_PROGRESSIVE_MAX_RESULTS, requestedMaxResults);
  let target = baseline;

  if (reason === "recrawl" || reason === "background") {
    target = Math.max(baseline, existingDepth + DEFAULT_PROGRESSIVE_STEP);
  } else if (reason === "expand") {
    target = Math.max(baseline, existingDepth);
  }

  return Math.min(target, dynamicCap, MAX_ALLOWED_RESULTS);
}

async function fetchAndCacheListings({
  query,
  cacheKey,
  requestedMaxResults,
  requestedMaxPages,
  useMock,
  reason,
  existingEntry,
} = {}) {
  const existingDepth =
    existingEntry && Array.isArray(existingEntry.listings)
      ? existingEntry.listings.length
      : 0;
  const targetResults = computeFetchTargetResults({
    existingDepth,
    requestedMaxResults,
    reason,
  });
  const targetPages = Math.min(
    ABSOLUTE_MAX_PAGES,
    Math.max(requestedMaxPages, Math.ceil(targetResults / MAX_PAGE_SIZE))
  );
  const ebayResult = await fetchFromEbay(query, {
    maxResults: targetResults,
    maxPages: targetPages,
  });
  const listings = ebayResult.listings;

  if (listings.length === 0 && useMock) {
    return buildMockResponse({
      source: "mock-empty-ebay",
      requestedMaxResults,
      totalMatchesEstimate: ebayResult.totalMatchesEstimate,
      apiCallsUsed: ebayResult.apiCallsUsed,
    });
  }

  const cacheEntry = {
    source: "ebay",
    cachedAt: Date.now(),
    listings,
    totalMatchesEstimate: ebayResult.totalMatchesEstimate,
    lastFetchReason: reason,
  };
  listingsCache.set(cacheKey, cacheEntry);

  return buildListingsResponse(cacheEntry, {
    requestedMaxResults,
    fetchMode: "api",
    cacheAgeMs: 0,
    apiCallsUsed: ebayResult.apiCallsUsed,
    fetchedCount: ebayResult.fetchedCount,
  });
}

function maybeStartBackgroundRefresh({
  cacheKey,
  query,
  cacheEntry,
  requestedMaxResults,
  requestedMaxPages,
  useMock,
  cacheAgeMs,
} = {}) {
  if (!cacheEntry) {
    return;
  }
  if (cacheAgeMs < DEFAULT_BACKGROUND_REFRESH_MS) {
    return;
  }
  if (listingsRefreshJobs.has(cacheKey)) {
    return;
  }
  const refreshJob = fetchAndCacheListings({
    query,
    cacheKey,
    requestedMaxResults,
    requestedMaxPages,
    useMock,
    reason: "background",
    existingEntry: cacheEntry,
  })
    .catch(() => null)
    .finally(() => {
      listingsRefreshJobs.delete(cacheKey);
    });
  listingsRefreshJobs.set(cacheKey, refreshJob);
}

async function getListings(options = {}) {
  const {
    query = "usps forever stamps",
    useMock = true,
    forceRefresh = false,
    recrawl = false,
    cacheTtlMs = DEFAULT_LISTINGS_CACHE_MS,
    maxResults = DEFAULT_MAX_RESULTS,
    maxPages = DEFAULT_MAX_PAGES,
  } = options;
  const normalizedQuery = normalizeQuery(query);
  const requestedMaxResults = sanitizePositiveInt(maxResults, DEFAULT_MAX_RESULTS, {
    min: 1,
    max: MAX_ALLOWED_RESULTS,
  });
  const requestedMaxPages = sanitizePositiveInt(maxPages, DEFAULT_MAX_PAGES, {
    min: 1,
    max: ABSOLUTE_MAX_PAGES,
  });
  const cacheKey = normalizedQuery.toLowerCase();
  const now = Date.now();
  const cached = listingsCache.get(cacheKey);
  const cacheAgeMs = cached ? now - cached.cachedAt : Number.MAX_SAFE_INTEGER;
  const isCacheFresh = cacheAgeMs <= Number(cacheTtlMs || DEFAULT_LISTINGS_CACHE_MS);
  const hasEnoughCachedListings =
    cached && Array.isArray(cached.listings) && cached.listings.length >= requestedMaxResults;

  if (!forceRefresh && !recrawl && hasEnoughCachedListings) {
    maybeStartBackgroundRefresh({
      cacheKey,
      query: normalizedQuery,
      cacheEntry: cached,
      requestedMaxResults,
      requestedMaxPages,
      useMock,
      cacheAgeMs,
    });
    return buildListingsResponse(cached, {
      requestedMaxResults,
      fetchMode: isCacheFresh ? "cache" : "cache-stale",
      cacheAgeMs,
      apiCallsUsed: 0,
      fetchedCount: 0,
    });
  }

  const needsExpansion =
    !forceRefresh &&
    !recrawl &&
    cached &&
    Array.isArray(cached.listings) &&
    cached.listings.length < requestedMaxResults;
  const fetchReason = recrawl
    ? "recrawl"
    : forceRefresh
    ? "force"
    : needsExpansion
    ? "expand"
    : "initial";

  const inFlight = listingsRefreshJobs.get(cacheKey);
  if (inFlight && !forceRefresh && !recrawl && !needsExpansion) {
    await inFlight.catch(() => null);
    const refreshedCache = listingsCache.get(cacheKey);
    if (refreshedCache && refreshedCache.listings.length >= requestedMaxResults) {
      const refreshedAgeMs = Math.max(0, Date.now() - refreshedCache.cachedAt);
      return buildListingsResponse(refreshedCache, {
        requestedMaxResults,
        fetchMode: "cache",
        cacheAgeMs: refreshedAgeMs,
        apiCallsUsed: 0,
        fetchedCount: 0,
      });
    }
  }

  try {
    return await fetchAndCacheListings({
      query: normalizedQuery,
      cacheKey,
      requestedMaxResults,
      requestedMaxPages,
      useMock,
      reason: fetchReason,
      existingEntry: cached || null,
    });
  } catch (error) {
    const fallbackCache = listingsCache.get(cacheKey);
    if (fallbackCache) {
      const staleAgeMs = Math.max(0, Date.now() - fallbackCache.cachedAt);
      return buildListingsResponse(fallbackCache, {
        requestedMaxResults,
        fetchMode: "cache-stale",
        cacheAgeMs: staleAgeMs,
        apiCallsUsed: 0,
        fetchedCount: 0,
      });
    }
    if (!useMock) {
      throw error;
    }
    return buildMockResponse({
      source: "mock-fallback",
      requestedMaxResults,
      totalMatchesEstimate: mockListings.length,
      apiCallsUsed: 0,
    });
  }
}

module.exports = {
  getListings,
  normalizeBrowseItem,
};
