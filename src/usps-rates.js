const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CACHE_PATH = path.join(__dirname, "..", "data", "usps-rates-cache.json");
const FALLBACK_PATH = path.join(__dirname, "..", "data", "usps-rates-fallback.json");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const USPS_SOURCES = {
  domesticForever: [
    {
      url: "https://www.usps.com/ship/letters.htm",
      patterns: [
        /Forever\s*stamp(?:s)?[^$]{0,80}\$([0-9]+\.[0-9]{2})/i,
        /1\s*oz[^$]{0,80}\$([0-9]+\.[0-9]{2})/i,
      ],
    },
    {
      url: "https://www.usps.com/business/prices.htm",
      patterns: [
        /First-Class\s*Mail[^$]{0,100}\$([0-9]+\.[0-9]{2})/i,
        /Forever[^$]{0,100}\$([0-9]+\.[0-9]{2})/i,
      ],
    },
  ],
  globalForever: [
    {
      url: "https://www.usps.com/international/first-class-mail-international.htm",
      patterns: [
        /Global\s*Forever[^$]{0,100}\$([0-9]+\.[0-9]{2})/i,
        /1\s*oz[^$]{0,80}\$([0-9]+\.[0-9]{2})/i,
      ],
    },
    {
      url: "https://www.usps.com/international/mail-shipping-services.htm",
      patterns: [/Global\s*Forever[^$]{0,120}\$([0-9]+\.[0-9]{2})/i],
    },
  ],
};

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

function writeJson(filePath, data) {
  const folder = path.dirname(filePath);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function getFreshCache() {
  const cache = readJson(CACHE_PATH);
  if (!cache || !cache.fetchedAt || !cache.rates) {
    return null;
  }
  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  if (ageMs < ONE_DAY_MS) {
    return cache;
  }
  return null;
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 eBay-Stamper/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  return response.data;
}

function findPrice(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const value = Number(match[1]);
      if (!Number.isNaN(value) && value > 0) {
        return value;
      }
    }
  }
  return null;
}

async function scrapeRateFromCandidates(candidates) {
  for (const candidate of candidates) {
    try {
      const html = await fetchHtml(candidate.url);
      const price = findPrice(html, candidate.patterns);
      if (price) {
        return price;
      }
    } catch (error) {
      continue;
    }
  }
  return null;
}

async function scrapeUspsRates() {
  const [domesticForever, globalForever] = await Promise.all([
    scrapeRateFromCandidates(USPS_SOURCES.domesticForever),
    scrapeRateFromCandidates(USPS_SOURCES.globalForever),
  ]);

  if (!domesticForever || !globalForever) {
    throw new Error("Could not extract all required USPS rates");
  }

  return { domesticForever, globalForever };
}

async function getUspsRates() {
  const freshCache = getFreshCache();
  if (freshCache) {
    return { rates: freshCache.rates, source: "cache" };
  }

  try {
    const scrapedRates = await scrapeUspsRates();
    const payload = {
      fetchedAt: new Date().toISOString(),
      rates: scrapedRates,
      source: "scrape",
    };
    writeJson(CACHE_PATH, payload);
    return { rates: scrapedRates, source: "scrape" };
  } catch (error) {
    const fallback = readJson(FALLBACK_PATH);
    if (!fallback || !fallback.rates) {
      throw new Error("USPS scrape failed and fallback data is unavailable");
    }
    return { rates: fallback.rates, source: "fallback" };
  }
}

module.exports = {
  getUspsRates,
  findPrice,
};
