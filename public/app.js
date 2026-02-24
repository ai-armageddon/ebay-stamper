const refs = {
  quickLook: document.getElementById("quickLook"),
  grid: document.getElementById("listingGrid"),
  barBoard: document.getElementById("barBoard"),
  listView: document.getElementById("listView"),
  template: document.getElementById("cardTemplate"),
  stats: document.getElementById("stats"),
  meta: document.getElementById("meta"),
  sortBy: document.getElementById("sortBy"),
  viewButtons: document.querySelectorAll("[data-view-mode]"),
  stampType: document.getElementById("stampType"),
  condition: document.getElementById("condition"),
  minDiscount: document.getElementById("minDiscount"),
  barThreshold: document.getElementById("barThreshold"),
  minTrust: document.getElementById("minTrust"),
  maxResults: document.getElementById("maxResults"),
  trustTier: document.getElementById("trustTier"),
  query: document.getElementById("query"),
  profitableOnly: document.getElementById("profitableOnly"),
  useMock: document.getElementById("useMock"),
  autoRefresh: document.getElementById("autoRefresh"),
  autoRefreshSec: document.getElementById("autoRefreshSec"),
  refreshBtn: document.getElementById("refreshBtn"),
  recrawlBtn: document.getElementById("recrawlBtn"),
};
let lastDeals = [];
let lastPayload = null;
let listSort = { key: "opportunityScore", direction: "desc" };
let currentViewMode = "cards";
let isLoadingDeals = false;
let autoRefreshTimer = null;

const UI_STATE_KEY = "ebay_stamper_ui_v1";

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return "#";
  } catch (error) {
    return "#";
  }
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
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

function captureScrollState() {
  const listShell = refs.listView.querySelector(".listShell");
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    listTop: listShell ? listShell.scrollTop : 0,
    listLeft: listShell ? listShell.scrollLeft : 0,
  };
}

function restoreScrollState(scrollState) {
  if (!scrollState) {
    return;
  }
  requestAnimationFrame(() => {
    window.scrollTo(scrollState.windowX, scrollState.windowY);
    const listShell = refs.listView.querySelector(".listShell");
    if (listShell) {
      listShell.scrollTop = scrollState.listTop;
      listShell.scrollLeft = scrollState.listLeft;
    }
  });
}

function collectUiState() {
  return {
    sortBy: refs.sortBy.value,
    stampType: refs.stampType.value,
    condition: refs.condition.value,
    minDiscount: refs.minDiscount.value,
    barThreshold: refs.barThreshold.value,
    minTrust: refs.minTrust.value,
    maxResults: refs.maxResults.value,
    trustTier: refs.trustTier.value,
    query: refs.query.value,
    profitableOnly: refs.profitableOnly.checked,
    useMock: refs.useMock.checked,
    autoRefresh: refs.autoRefresh.checked,
    autoRefreshSec: refs.autoRefreshSec.value,
    currentViewMode,
    listSort,
  };
}

function saveUiState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(collectUiState()));
  } catch (error) {
    // Ignore localStorage failures.
  }
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (!raw) {
      return;
    }
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object") {
      return;
    }
    if (state.sortBy) refs.sortBy.value = state.sortBy;
    if (state.stampType) refs.stampType.value = state.stampType;
    if (state.condition) refs.condition.value = state.condition;
    if (state.minDiscount !== undefined) refs.minDiscount.value = state.minDiscount;
    if (state.barThreshold !== undefined) refs.barThreshold.value = state.barThreshold;
    if (state.minTrust !== undefined) refs.minTrust.value = state.minTrust;
    if (state.maxResults !== undefined) refs.maxResults.value = state.maxResults;
    if (state.trustTier) refs.trustTier.value = state.trustTier;
    if (state.query !== undefined) refs.query.value = state.query;
    if (typeof state.profitableOnly === "boolean") refs.profitableOnly.checked = state.profitableOnly;
    if (typeof state.useMock === "boolean") refs.useMock.checked = state.useMock;
    if (typeof state.autoRefresh === "boolean") refs.autoRefresh.checked = state.autoRefresh;
    if (state.autoRefreshSec) refs.autoRefreshSec.value = state.autoRefreshSec;
    if (state.currentViewMode) currentViewMode = state.currentViewMode;
    if (state.listSort && state.listSort.key && state.listSort.direction) {
      listSort = state.listSort;
    }
  } catch (error) {
    // Ignore parse/storage failures.
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!refs.autoRefresh.checked) {
    return;
  }
  const seconds = parsePositiveInt(refs.autoRefreshSec.value, 120, {
    min: 30,
    max: 3600,
  });
  autoRefreshTimer = setInterval(() => {
    loadDeals({ trigger: "auto", preserveScroll: true });
  }, seconds * 1000);
}

function statCard(label, value) {
  return `
    <article class="statCard">
      <p class="statLabel">${label}</p>
      <p class="statValue">${value}</p>
    </article>
  `;
}

function setQuickLook(payload) {
  const hasBest = payload.summary && payload.summary.bestDealTitle;
  const perStampValue = hasBest
    ? `${formatMoney(payload.summary.bestDealCostPerStamp)} vs ${formatMoney(
        payload.summary.bestDealUspsPerStamp
      )}`
    : "n/a";
  const totalBuy = hasBest ? formatMoney(payload.summary.bestDealTotalCost) : "n/a";
  const multiplier = hasBest
    ? `${Number(payload.summary.bestDealMultiplier || 0).toFixed(2)}x`
    : "n/a";

  refs.quickLook.innerHTML = [
    statCard("Top Per-Stamp vs USPS", perStampValue),
    statCard("Top Total Buy Price", totalBuy),
    statCard("Top Value Multiplier", multiplier),
    statCard("USPS Domestic", formatMoney(payload.rates.domesticForever)),
    statCard("USPS Global", formatMoney(payload.rates.globalForever)),
  ].join("");
}

function setStats(payload) {
  const crawl = payload.crawlStats || {};
  refs.stats.innerHTML = [
    statCard("Profitable Listings", String(payload.summary.profitableCount || 0)),
    statCard("Elite Deals", String(payload.summary.eliteCount || 0)),
    statCard("Average Discount", `${Number(payload.summary.avgDiscount || 0).toFixed(2)}%`),
    statCard("Average Trust", `${Number(payload.summary.avgTrust || 0).toFixed(1)}/100`),
    statCard("Compared This View", String(payload.totalCompared || 0)),
    statCard("After Filters", String(payload.totalAfterFilters || 0)),
    statCard("Crawl Depth", String(crawl.crawlDepth || payload.totalListings || 0)),
    statCard("Pulled This Call", String(crawl.fetchedCount || 0)),
    statCard("eBay API Calls", String(crawl.apiCallsUsed || 0)),
  ].join("");
}

function setMeta(payload) {
  const best = payload.summary.bestDealTitle
    ? `${payload.summary.bestDealTitle} (${payload.summary.bestDealDiscount}% under USPS, ${payload.summary.bestDealSignal})`
    : "No profitable listing in current view";
  const crawl = payload.crawlStats || {};
  const estimate = Number.isFinite(Number(crawl.totalMatchesEstimate))
    ? `~${Number(crawl.totalMatchesEstimate)}`
    : "n/a";
  const cacheLabel =
    payload.listingsFetchMode === "cache" || payload.listingsFetchMode === "cache-stale"
      ? `cache (${Math.round(Number(payload.listingsCacheAgeMs || 0) / 1000)}s old)`
      : payload.listingsFetchMode || "api";
  refs.meta.innerHTML = `
    <div class="metaChips">
      <span class="metaChip">Rates: ${escapeHtml(payload.ratesSource)}</span>
      <span class="metaChip">Listings: ${escapeHtml(payload.listingsSource)} via ${escapeHtml(
        cacheLabel
      )}</span>
      <span class="metaChip">Compared: ${payload.totalCompared}</span>
      <span class="metaChip">Filtered: ${payload.totalAfterFilters}</span>
      <span class="metaChip">Crawled: ${crawl.crawlDepth || payload.totalListings}</span>
      <span class="metaChip">Matches Est: ${escapeHtml(estimate)}</span>
    </div>
    <p class="metaBest">Best: ${escapeHtml(best)}</p>
  `;
}

function makeBadge(deal) {
  if (deal.discountPct >= 25) {
    return "Elite Deal";
  }
  if (deal.discountPct >= 10) {
    return "Good Deal";
  }
  if (deal.discountPct > 0) {
    return "Slight Edge";
  }
  return "Over Market";
}

function badgeClass(deal) {
  if (deal.dealTier === "elite") {
    return "elite";
  }
  if (deal.dealTier === "strong") {
    return "strong";
  }
  if (deal.dealTier === "watch") {
    return "watch";
  }
  return "pass";
}

function trustLabel(deal) {
  const pct =
    deal.sellerFeedbackPercentage === null || deal.sellerFeedbackPercentage === undefined
      ? "n/a"
      : `${Number(deal.sellerFeedbackPercentage).toFixed(1)}%`;
  const score =
    deal.sellerFeedbackScore === null || deal.sellerFeedbackScore === undefined
      ? "n/a"
      : String(deal.sellerFeedbackScore);
  const topRated = deal.sellerTopRated ? " | Top Rated" : "";
  return `Trust ${Number(deal.trustScore || 0).toFixed(1)}/100 (${deal.trustTier}) | Feedback ${pct} / ${score}${topRated}`;
}

function descriptionSnippet(text) {
  const clean = String(text || "").trim();
  if (!clean) {
    return "Description not available from API summary.";
  }
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

function renderCardDeals(deals) {
  refs.listView.classList.add("hidden");
  refs.barBoard.classList.add("hidden");
  refs.grid.classList.remove("hidden");
  refs.grid.innerHTML = "";
  if (!deals.length) {
    refs.grid.innerHTML = '<div class="empty">No listings match your current filters.</div>';
    return;
  }

  deals.forEach((deal) => {
    const node = refs.template.content.cloneNode(true);
    const img = node.querySelector("img");
    const title = node.querySelector(".title");
    const metricPerStamp = node.querySelector(".metricPerStamp");
    const metricTotalBuy = node.querySelector(".metricTotalBuy");
    const metricMultiplier = node.querySelector(".metricMultiplier");
    const seller = node.querySelector(".seller");
    const trust = node.querySelector(".trust");
    const signal = node.querySelector(".signal");
    const description = node.querySelector(".description");
    const pricing = node.querySelector(".pricing");
    const perStamp = node.querySelector(".perStamp");
    const arbitrage = node.querySelector(".arbitrage");
    const metaLine = node.querySelector(".metaLine");
    const cta = node.querySelector(".cta");
    const badge = node.querySelector(".dealBadge");
    const card = node.querySelector(".card");

    img.src = deal.image || "https://picsum.photos/seed/fallback/400/280";
    title.textContent = deal.title;
    metricPerStamp.textContent = `${formatMoney(deal.costPerStamp)} vs ${formatMoney(
      deal.uspsPerStamp
    )}`;
    metricTotalBuy.textContent = `Buy ${formatMoney(deal.totalCost)}`;
    metricMultiplier.textContent = `${valueMultiplier(deal).toFixed(2)}x`;
    seller.textContent = `Seller: ${deal.seller} | Condition: ${deal.condition}`;
    trust.textContent = trustLabel(deal);
    signal.textContent = `${deal.buySignal} | Opportunity Score ${Number(
      deal.opportunityScore || 0
    ).toFixed(1)}`;
    signal.className = `signal ${badgeClass(deal)}`;
    description.textContent = descriptionSnippet(deal.description);
    pricing.textContent = `Total cost: ${formatMoney(deal.totalCost)} (item ${formatMoney(
      deal.listingPrice
    )} + ship ${formatMoney(deal.shippingCost)}) | USPS value: ${formatMoney(deal.marketValue)}`;
    perStamp.textContent = `Per stamp: ${formatMoney(deal.costPerStamp)} vs USPS ${formatMoney(
      deal.uspsPerStamp
    )} (delta ${formatMoney(deal.perStampSavings)}, ${deal.perStampDiscountPct}%)`;
    perStamp.className = `perStamp ${deal.perStampSavings >= 0 ? "good" : "bad"}`;
    arbitrage.textContent = `Underpriced vs USPS: ${formatMoney(deal.underpricedDollars)} (${deal.underpricedPct}%)`;
    arbitrage.className = `arbitrage ${deal.profitable ? "good" : "bad"}`;
    const countConfidence = `${Math.round(Number(deal.stampCountConfidence || 0) * 100)}%`;
    metaLine.textContent = `${deal.stampType.toUpperCase()} | ${deal.stampCount} stamps | ${deal.trustSignals
      .slice(0, 2)
      .join(" | ")} | Qty Parse ${countConfidence} (${deal.stampCountSource || "title"})`;
    cta.href = safeUrl(deal.itemWebUrl);
    badge.textContent = makeBadge(deal);
    badge.className = `dealBadge ${badgeClass(deal)}`;
    card.classList.add(`tier-${badgeClass(deal)}`);

    refs.grid.appendChild(node);
  });
}

function barWidth(value) {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

function valueMultiplier(deal) {
  const cost = Number(deal.totalCost || 0);
  if (cost <= 0) {
    return 0;
  }
  return Number(deal.marketValue || 0) / cost;
}

function renderBarDeals(deals) {
  refs.listView.classList.add("hidden");
  refs.grid.classList.add("hidden");
  refs.barBoard.classList.remove("hidden");
  refs.barBoard.innerHTML = "";

  const threshold = Number(refs.barThreshold.value || 0);
  const qualified = deals.filter(
    (deal) => Number(deal.underpricedPct || 0) >= threshold
  );

  if (!qualified.length) {
    refs.barBoard.innerHTML =
      '<div class="empty">No deals pass the current bar threshold.</div>';
    return;
  }

  qualified.forEach((deal) => {
    const row = document.createElement("article");
    row.className = `barRow tier-${badgeClass(deal)}`;

    const header = document.createElement("div");
    header.className = "barHeader";

    const title = document.createElement("p");
    title.className = "barTitle";
    title.textContent = deal.title;

    const metrics = document.createElement("p");
    metrics.className = "barMetrics";
    metrics.textContent = `Spread ${formatMoney(deal.underpricedDollars)} (${Number(
      deal.underpricedPct || 0
    ).toFixed(2)}%)`;

    header.appendChild(title);
    header.appendChild(metrics);

    const keyMetrics = document.createElement("div");
    keyMetrics.className = "barKeyMetrics";
    keyMetrics.innerHTML = `
      <span class="barMetricChip">${formatMoney(deal.costPerStamp)} vs ${formatMoney(
        deal.uspsPerStamp
      )} /stamp</span>
      <span class="barMetricChip">Buy ${formatMoney(deal.totalCost)}</span>
      <span class="barMetricChip">${valueMultiplier(deal).toFixed(2)}x value</span>
    `;

    const track = document.createElement("div");
    track.className = "barTrack";

    const fill = document.createElement("div");
    fill.className = `barFill ${badgeClass(deal)}`;
    fill.style.width = `${barWidth(deal.underpricedPct)}%`;
    track.appendChild(fill);

    const footer = document.createElement("div");
    footer.className = "barFooter";
    const countConfidence = `${Math.round(Number(deal.stampCountConfidence || 0) * 100)}%`;
    footer.textContent = `${deal.buySignal} | Trust ${Number(
      deal.trustScore || 0
    ).toFixed(1)} | Seller ${deal.seller} | ${deal.stampType.toUpperCase()} ${
      deal.stampCount
    } ct (${countConfidence} qty parse)`;

    const link = document.createElement("a");
    link.className = "barCta";
    link.href = safeUrl(deal.itemWebUrl);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open";

    row.appendChild(header);
    row.appendChild(keyMetrics);
    row.appendChild(track);
    row.appendChild(footer);
    row.appendChild(link);
    refs.barBoard.appendChild(row);
  });
}

function getListSortValue(deal, key) {
  if (key === "title" || key === "seller" || key === "condition") {
    return String(deal[key] || "").toLowerCase();
  }
  if (key === "multiplier") {
    return valueMultiplier(deal);
  }
  return Number(deal[key] || 0);
}

function sortDealsForList(deals) {
  const output = [...deals];
  output.sort((a, b) => {
    const left = getListSortValue(a, listSort.key);
    const right = getListSortValue(b, listSort.key);
    if (typeof left === "string" && typeof right === "string") {
      return listSort.direction === "asc"
        ? left.localeCompare(right)
        : right.localeCompare(left);
    }
    return listSort.direction === "asc" ? left - right : right - left;
  });
  return output;
}

function listHeader(label, key) {
  const isActive = listSort.key === key;
  const direction = isActive ? (listSort.direction === "asc" ? "↑" : "↓") : "";
  return `<button class="listSortBtn ${isActive ? "active" : ""}" data-sort-key="${key}" type="button">${label} ${direction}</button>`;
}

function renderListDeals(deals) {
  refs.grid.classList.add("hidden");
  refs.barBoard.classList.add("hidden");
  refs.listView.classList.remove("hidden");

  if (!deals.length) {
    refs.listView.innerHTML = '<div class="empty">No listings match your current filters.</div>';
    return;
  }

  const sorted = sortDealsForList(deals);
  const rows = sorted
    .map((deal) => {
      const multiplier = `${valueMultiplier(deal).toFixed(2)}x`;
      const safeHref = safeUrl(deal.itemWebUrl);
      return `
        <tr>
          <td class="colTitle">${escapeHtml(deal.title)}</td>
          <td>${formatMoney(deal.costPerStamp)}</td>
          <td>${formatMoney(deal.uspsPerStamp)}</td>
          <td>${deal.stampCount}</td>
          <td>${formatMoney(deal.totalCost)}</td>
          <td>${multiplier}</td>
          <td>${formatMoney(deal.underpricedDollars)}</td>
          <td>${formatPercent(deal.underpricedPct)}</td>
          <td>${Number(deal.trustScore || 0).toFixed(1)}</td>
          <td>${escapeHtml(deal.seller)}</td>
          <td>${escapeHtml(deal.condition)}</td>
          <td>${escapeHtml(deal.buySignal)}</td>
          <td><a class="tableLink" target="_blank" rel="noopener noreferrer" href="${safeHref}">Open</a></td>
        </tr>
      `;
    })
    .join("");

  refs.listView.innerHTML = `
    <div class="listShell">
      <table class="listTable">
        <colgroup>
          <col class="colTitleWidth" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colNumeric" />
          <col class="colSeller" />
          <col class="colCondition" />
          <col class="colSignal" />
          <col class="colLink" />
        </colgroup>
        <thead>
          <tr>
            <th>${listHeader("Title", "title")}</th>
            <th>${listHeader("Buy / Stamp", "costPerStamp")}</th>
            <th>${listHeader("USPS / Stamp", "uspsPerStamp")}</th>
            <th>${listHeader("Qty", "stampCount")}</th>
            <th>${listHeader("Total Buy", "totalCost")}</th>
            <th>${listHeader("Value x", "multiplier")}</th>
            <th>${listHeader("Spread $", "underpricedDollars")}</th>
            <th>${listHeader("Spread %", "underpricedPct")}</th>
            <th>${listHeader("Trust", "trustScore")}</th>
            <th>${listHeader("Seller", "seller")}</th>
            <th>${listHeader("Condition", "condition")}</th>
            <th>${listHeader("Buy Signal", "opportunityScore")}</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  refs.listView.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const scrollState = captureScrollState();
      const nextKey = button.getAttribute("data-sort-key");
      if (listSort.key === nextKey) {
        listSort.direction = listSort.direction === "asc" ? "desc" : "asc";
      } else {
        listSort = { key: nextKey, direction: "desc" };
      }
      saveUiState();
      renderListDeals(lastDeals);
      restoreScrollState(scrollState);
    });
  });
}

function renderDeals(deals) {
  if (currentViewMode === "list") {
    renderListDeals(deals);
    return;
  }
  if (currentViewMode === "bars") {
    renderBarDeals(deals);
    return;
  }
  renderCardDeals(deals);
}

function setViewMode(mode) {
  currentViewMode = mode;
  refs.viewButtons.forEach((button) => {
    const active = button.getAttribute("data-view-mode") === mode;
    button.classList.toggle("active", active);
  });
  saveUiState();
  renderDeals(lastDeals);
}

async function loadDeals(options = {}) {
  const { trigger = "manual", preserveScroll = true, recrawl = false } = options;
  if (isLoadingDeals) {
    return;
  }
  isLoadingDeals = true;
  const scrollState = preserveScroll ? captureScrollState() : null;

  if (trigger === "manual" || trigger === "recrawl") {
    refs.refreshBtn.disabled = true;
    refs.recrawlBtn.disabled = true;
    refs.refreshBtn.textContent = trigger === "recrawl" ? "Refreshing..." : "Loading...";
    refs.recrawlBtn.textContent = trigger === "recrawl" ? "Recrawling..." : "Recrawl Deeper";
  }
  try {
    const params = new URLSearchParams({
      sort: refs.sortBy.value,
      stampType: refs.stampType.value,
      condition: refs.condition.value,
      minDiscount: refs.minDiscount.value,
      minTrust: refs.minTrust.value,
      maxResults: String(
        parsePositiveInt(refs.maxResults.value, 150, { min: 50, max: 600 })
      ),
      trustTier: refs.trustTier.value,
      q: refs.query.value,
      profitableOnly: refs.profitableOnly.checked ? "true" : "false",
      useMock: refs.useMock.checked ? "true" : "false",
    });
    if (recrawl) {
      params.set("recrawl", "true");
    }
    const response = await fetch(`/api/deals?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.details || payload.error || "Failed to load");
    }
    lastPayload = payload;
    lastDeals = payload.deals;
    setQuickLook(payload);
    setStats(payload);
    setMeta(payload);
    renderDeals(lastDeals);
    restoreScrollState(scrollState);
    saveUiState();
  } catch (error) {
    refs.barBoard.classList.add("hidden");
    refs.listView.classList.add("hidden");
    refs.grid.classList.remove("hidden");
    refs.grid.innerHTML = `<div class="empty">${error.message}</div>`;
  } finally {
    if (trigger === "manual" || trigger === "recrawl") {
      refs.refreshBtn.disabled = false;
      refs.recrawlBtn.disabled = false;
      refs.refreshBtn.textContent = "Refresh View";
      refs.recrawlBtn.textContent = "Recrawl Deeper";
    }
    isLoadingDeals = false;
  }
}

refs.refreshBtn.addEventListener("click", () =>
  loadDeals({ trigger: "manual", preserveScroll: true })
);
refs.recrawlBtn.addEventListener("click", () => {
  const bumped = parsePositiveInt(refs.maxResults.value, 150, {
    min: 50,
    max: 600,
  });
  const next = Math.min(600, bumped + 50);
  if (next !== bumped) {
    refs.maxResults.value = String(next);
  }
  saveUiState();
  loadDeals({ trigger: "recrawl", preserveScroll: true, recrawl: true });
});
refs.viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.getAttribute("data-view-mode");
    setViewMode(mode || "cards");
  });
});
refs.barThreshold.addEventListener("input", () => {
  saveUiState();
  if (currentViewMode === "bars") {
    renderDeals(lastDeals);
  }
});

[
  refs.sortBy,
  refs.stampType,
  refs.condition,
  refs.minDiscount,
  refs.minTrust,
  refs.maxResults,
  refs.trustTier,
  refs.query,
  refs.profitableOnly,
  refs.useMock,
].forEach((control) => {
  control.addEventListener("change", saveUiState);
});

refs.autoRefresh.addEventListener("change", () => {
  saveUiState();
  startAutoRefresh();
});

refs.autoRefreshSec.addEventListener("change", () => {
  saveUiState();
  startAutoRefresh();
});

window.addEventListener("beforeunload", stopAutoRefresh);

window.addEventListener("load", () => {
  loadUiState();
  setViewMode(currentViewMode);
  startAutoRefresh();
  loadDeals({ trigger: "manual", preserveScroll: false });
});
