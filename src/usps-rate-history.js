const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { getUspsRates } = require("./usps-rates");

const HISTORY_PATH = path.join(__dirname, "..", "data", "usps-rate-history.json");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_START_DATE = "2022-12-04";
const HISTORY_BASELINE_RATES = {
  domesticForever: 0.6,
  globalForever: 1.4,
};

const NEWS_FEED_URL = "https://news.usps.com/feed/";

const CURATED_ANNOUNCEMENT_URLS = [
  "https://about.usps.com/newsroom/national-releases/2022/1007-usps-announces-new-prices-for-2023.htm",
  "https://about.usps.com/newsroom/national-releases/2023/0410-usps-files-notice-with-prc-for-new-mailing-services-pricing.htm",
  "https://about.usps.com/newsroom/national-releases/2023/1006-usps-proposes-new-prices-for-2024.htm",
  "https://news.usps.com/2024/04/09/usps-recommends-new-prices/",
  "https://news.usps.com/2025/04/09/usps-recommends-new-prices-2/",
  "https://news.usps.com/2025/07/14/usps-adjusts-prices/",
  "https://about.usps.com/newsroom/national-releases/2025/0924-usps-announces-no-stamp-price-changes-for-january-2026.htm",
];

const LIVE_RATE_SOURCE_URLS = [
  "https://www.usps.com/ship/letters.htm",
  "https://www.usps.com/international/first-class-mail-international.htm",
];

const MANUAL_FALLBACK_CHANGES = [
  {
    effectiveDate: "2023-01-22",
    domesticForever: 0.63,
    globalForever: 1.45,
    sourceUrls: [
      "https://about.usps.com/newsroom/national-releases/2022/1007-usps-announces-new-prices-for-2023.htm",
    ],
    sourceType: "manual-fallback",
  },
  {
    effectiveDate: "2023-07-09",
    domesticForever: 0.66,
    globalForever: 1.5,
    sourceUrls: [
      "https://about.usps.com/newsroom/national-releases/2023/0410-usps-files-notice-with-prc-for-new-mailing-services-pricing.htm",
    ],
    sourceType: "manual-fallback",
  },
  {
    effectiveDate: "2024-01-21",
    domesticForever: 0.68,
    globalForever: 1.55,
    sourceUrls: [
      "https://about.usps.com/newsroom/national-releases/2023/1006-usps-proposes-new-prices-for-2024.htm",
    ],
    sourceType: "manual-fallback",
  },
  {
    effectiveDate: "2024-07-14",
    domesticForever: 0.73,
    globalForever: 1.65,
    sourceUrls: [
      "https://news.usps.com/2024/04/09/usps-recommends-new-prices/",
    ],
    sourceType: "manual-fallback",
  },
  {
    effectiveDate: "2025-07-13",
    domesticForever: 0.78,
    globalForever: 1.7,
    sourceUrls: [
      "https://news.usps.com/2025/04/09/usps-recommends-new-prices-2/",
      "https://news.usps.com/2025/07/14/usps-adjusts-prices/",
    ],
    sourceType: "manual-fallback",
  },
];

const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  const folderPath = path.dirname(filePath);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function parseUsDate(label, fallbackYear) {
  if (!label) {
    return null;
  }
  const cleaned = label.replace(/\./g, "").replace(/,/g, " ").trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const monthToken = parts[0].slice(0, 3).toLowerCase();
  const month = MONTH_INDEX[monthToken];
  const day = Number(parts[1]);
  const maybeYear = parts[2] ? Number(parts[2]) : Number(fallbackYear);

  if (
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(maybeYear) ||
    day < 1 ||
    day > 31 ||
    maybeYear < 1900
  ) {
    return null;
  }
  return toDateString(new Date(Date.UTC(maybeYear, month, day)));
}

function extractYearFromUrl(url) {
  const match = String(url).match(/\/(20\d{2})\//);
  return match ? Number(match[1]) : null;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    );
}

function htmlToText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function extractEffectiveDate(text, sourceUrl) {
  const patterns = [
    /(?:scheduled to take effect|to take effect|take effect)(?:\s+on)?(?:\s+\w+,)?\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:,\s+\d{4})?)/i,
    /effective(?:\s+date)?(?:\s+is|:)?\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:,\s+\d{4})?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }
    const parsed = parseUsDate(match[1], extractYearFromUrl(sourceUrl));
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function findPriceLine(lines, patterns) {
  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return line;
      }
    }
  }
  return null;
}

function parsePriceToken(rawToken, hasCentsWord) {
  const numeric = rawToken.replace("$", "");
  const value = Number(numeric);
  if (Number.isNaN(value) || value <= 0) {
    return null;
  }
  const hasDollarSign = rawToken.includes("$");
  const hasDecimal = numeric.includes(".");

  if (hasDollarSign || hasDecimal) {
    return roundCurrency(value);
  }
  if (hasCentsWord || value >= 10) {
    return roundCurrency(value / 100);
  }
  return null;
}

function parsePlannedPriceFromLine(line) {
  if (!line) {
    return null;
  }
  const valueSection = line.includes(":")
    ? line.slice(line.indexOf(":") + 1)
    : line;
  const pricePattern = /(\$?\d+(?:\.\d+)?)(?:\s*(cents?|cent))?/gi;
  const parsedValues = [];

  let match = pricePattern.exec(valueSection);
  while (match) {
    const parsed = parsePriceToken(match[1], Boolean(match[2]));
    if (parsed) {
      parsedValues.push(parsed);
    }
    match = pricePattern.exec(valueSection);
  }

  if (parsedValues.length === 0) {
    return null;
  }
  return parsedValues[parsedValues.length - 1];
}

function parseRateAnnouncement(html, sourceUrl) {
  const text = htmlToText(html);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const effectiveDate = extractEffectiveDate(text, sourceUrl);
  const domesticLine = findPriceLine(lines, [
    /letters?\s*\(1\s*(?:ounce|oz\.?)\)/i,
    /forever\s+stamp/i,
  ]);
  const globalLine = findPriceLine(lines, [
    /international\s+letters?\s*\(1\s*(?:ounce|oz\.?)\)/i,
    /international\s+letter\s*\(1\s*(?:ounce|oz\.?)\)/i,
    /global\s+forever/i,
    /another\s+country/i,
  ]);

  const domesticForever = parsePlannedPriceFromLine(domesticLine);
  const globalForever = parsePlannedPriceFromLine(globalLine);

  if (!effectiveDate || !domesticForever || !globalForever) {
    return null;
  }

  return {
    effectiveDate,
    domesticForever,
    globalForever,
    sourceUrls: [sourceUrl],
    sourceType: sourceUrl.includes("about.usps.com")
      ? "about-usps"
      : "news-usps",
  };
}

function sameRates(left, right) {
  return (
    roundCurrency(left.domesticForever) === roundCurrency(right.domesticForever) &&
    roundCurrency(left.globalForever) === roundCurrency(right.globalForever)
  );
}

function mergeRateEvents(events) {
  const map = new Map();

  for (const event of events) {
    if (
      !event ||
      !event.effectiveDate ||
      !event.domesticForever ||
      !event.globalForever
    ) {
      continue;
    }

    const existing = map.get(event.effectiveDate);
    if (!existing) {
      map.set(event.effectiveDate, {
        effectiveDate: event.effectiveDate,
        domesticForever: roundCurrency(event.domesticForever),
        globalForever: roundCurrency(event.globalForever),
        sourceType: event.sourceType || "unknown",
        sourceUrls: [...new Set(event.sourceUrls || [])],
        conflicts: [],
      });
      continue;
    }

    if (!sameRates(existing, event)) {
      existing.conflicts.push({
        domesticForever: roundCurrency(event.domesticForever),
        globalForever: roundCurrency(event.globalForever),
        sourceUrls: [...new Set(event.sourceUrls || [])],
      });
      continue;
    }

    existing.sourceUrls = [...new Set([...existing.sourceUrls, ...(event.sourceUrls || [])])];
    if (existing.sourceType === "manual-fallback" && event.sourceType) {
      existing.sourceType = event.sourceType;
    }
  }

  return [...map.values()].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate)
  );
}

function getRateOnDate(rateChanges, targetDate, baselineRates = HISTORY_BASELINE_RATES) {
  const sortedChanges = [...rateChanges].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate)
  );

  let rates = {
    domesticForever: baselineRates.domesticForever,
    globalForever: baselineRates.globalForever,
  };

  for (const change of sortedChanges) {
    if (change.effectiveDate <= targetDate) {
      rates = {
        domesticForever: change.domesticForever,
        globalForever: change.globalForever,
      };
      continue;
    }
    break;
  }

  return rates;
}

function buildDailyRates({
  rateChanges,
  startDate = HISTORY_START_DATE,
  endDate = toDateString(new Date()),
  baselineRates = HISTORY_BASELINE_RATES,
}) {
  const sortedChanges = [...rateChanges].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate)
  );
  const rows = [];
  let changeIndex = 0;
  let activeRate = {
    domesticForever: baselineRates.domesticForever,
    globalForever: baselineRates.globalForever,
  };
  let activeSource = "baseline";

  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);

  while (cursor.getTime() <= end.getTime()) {
    const currentDate = toDateString(cursor);
    while (
      changeIndex < sortedChanges.length &&
      sortedChanges[changeIndex].effectiveDate <= currentDate
    ) {
      activeRate = {
        domesticForever: sortedChanges[changeIndex].domesticForever,
        globalForever: sortedChanges[changeIndex].globalForever,
      };
      activeSource = sortedChanges[changeIndex].sourceUrls[0] || "unknown-source";
      changeIndex += 1;
    }

    rows.push({
      date: currentDate,
      domesticForever: roundCurrency(activeRate.domesticForever),
      globalForever: roundCurrency(activeRate.globalForever),
      source: activeSource,
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return rows;
}

function historyIsFresh(history) {
  if (!history || !history.generatedAt) {
    return false;
  }
  const age = Date.now() - new Date(history.generatedAt).getTime();
  return age < ONE_DAY_MS;
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0 eBay-Stamper/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml",
    },
  });
  return String(response.data || "");
}

function extractRateLinksFromFeed(xml) {
  const itemRegex =
    /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>(https:\/\/news\.usps\.com\/[^<]+)<\/link>[\s\S]*?<\/item>/gi;
  const links = [];

  let match = itemRegex.exec(xml);
  while (match) {
    const title = decodeHtmlEntities(match[1]).toLowerCase();
    if (
      /\b(price|prices|pricing)\b/.test(title) ||
      /new pricing/.test(title) ||
      /new prices/.test(title)
    ) {
      links.push(match[2].trim());
    }
    match = itemRegex.exec(xml);
  }

  return [...new Set(links)];
}

async function discoverAnnouncementUrls() {
  const urls = [...CURATED_ANNOUNCEMENT_URLS];

  try {
    const xml = await fetchText(NEWS_FEED_URL);
    const discovered = extractRateLinksFromFeed(xml);
    return [...new Set([...urls, ...discovered])];
  } catch (error) {
    return urls;
  }
}

async function scrapeAnnouncementEvents() {
  const urls = await discoverAnnouncementUrls();
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const html = await fetchText(url);
      return parseRateAnnouncement(html, url);
    })
  );

  const events = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      events.push(result.value);
    }
  }
  return events;
}

function appendSyntheticCurrentChangeIfNeeded(rateChanges, liveRates) {
  if (!liveRates || !liveRates.domesticForever || !liveRates.globalForever) {
    return rateChanges;
  }

  const today = toDateString(new Date());
  const currentKnown = getRateOnDate(rateChanges, today);

  if (sameRates(currentKnown, liveRates)) {
    return rateChanges;
  }

  return [
    ...rateChanges,
    {
      effectiveDate: today,
      domesticForever: roundCurrency(liveRates.domesticForever),
      globalForever: roundCurrency(liveRates.globalForever),
      sourceType: "usps-live-scrape",
      sourceUrls: [...LIVE_RATE_SOURCE_URLS],
      inferredEffectiveDate: true,
    },
  ];
}

async function buildRateHistoryPayload() {
  const scrapedEvents = await scrapeAnnouncementEvents();
  let mergedChanges = mergeRateEvents([...MANUAL_FALLBACK_CHANGES, ...scrapedEvents]);

  let liveRates = null;
  try {
    const live = await getUspsRates();
    liveRates = live.rates;
  } catch (error) {
    liveRates = null;
  }

  mergedChanges = mergeRateEvents(
    appendSyntheticCurrentChangeIfNeeded(mergedChanges, liveRates)
  );

  const endDate = toDateString(new Date());
  const dailyRates = buildDailyRates({
    rateChanges: mergedChanges,
    startDate: HISTORY_START_DATE,
    endDate,
    baselineRates: HISTORY_BASELINE_RATES,
  });

  return {
    generatedAt: new Date().toISOString(),
    historyStartDate: HISTORY_START_DATE,
    historyEndDate: endDate,
    baseline: {
      effectiveDate: HISTORY_START_DATE,
      domesticForever: HISTORY_BASELINE_RATES.domesticForever,
      globalForever: HISTORY_BASELINE_RATES.globalForever,
      source: "baseline-manual",
    },
    sourceCatalog: {
      curatedAnnouncementUrls: CURATED_ANNOUNCEMENT_URLS,
      newsFeedUrl: NEWS_FEED_URL,
      liveRateUrls: LIVE_RATE_SOURCE_URLS,
    },
    rateChanges: mergedChanges,
    dailyRates,
  };
}

async function refreshRateHistory() {
  const payload = await buildRateHistoryPayload();
  writeJson(HISTORY_PATH, payload);
  return payload;
}

async function getRateHistory(options = {}) {
  const { forceRefresh = false } = options;
  const existing = readJson(HISTORY_PATH);

  if (!forceRefresh && historyIsFresh(existing)) {
    return existing;
  }

  try {
    return await refreshRateHistory();
  } catch (error) {
    if (existing) {
      return existing;
    }
    throw error;
  }
}

module.exports = {
  HISTORY_PATH,
  HISTORY_START_DATE,
  HISTORY_BASELINE_RATES,
  parseRateAnnouncement,
  mergeRateEvents,
  buildDailyRates,
  buildRateHistoryPayload,
  refreshRateHistory,
  getRateHistory,
};
