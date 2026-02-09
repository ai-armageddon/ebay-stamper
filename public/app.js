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
  trustTier: document.getElementById("trustTier"),
  query: document.getElementById("query"),
  profitableOnly: document.getElementById("profitableOnly"),
  useMock: document.getElementById("useMock"),
  forceEbayRefresh: document.getElementById("forceEbayRefresh"),
  refreshBtn: document.getElementById("refreshBtn"),
};
let lastDeals = [];
let lastPayload = null;
let listSort = { key: "opportunityScore", direction: "desc" };
let currentViewMode = "cards";

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
    statCard("Compared", String(payload.totalCompared || 0)),
    statCard("After Filters", String(payload.totalAfterFilters || 0)),
    statCard("Pulled This Call", String(crawl.fetchedCount || payload.totalListings || 0)),
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
    payload.listingsFetchMode === "cache"
      ? `cache (${Math.round(Number(payload.listingsCacheAgeMs || 0) / 1000)}s old)`
      : payload.listingsFetchMode || "api";
  refs.meta.textContent =
    `Rates: ${payload.ratesSource} | Listings: ${payload.listingsSource} via ${cacheLabel} | ` +
    `Compared: ${payload.totalCompared} | Filtered: ${payload.totalAfterFilters} | ` +
    `Pulled: ${crawl.fetchedCount || payload.totalListings} of estimated ${estimate} matches | Best: ${best}`;
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
    metaLine.textContent = `${deal.stampType.toUpperCase()} | ${deal.stampCount} stamps | ${deal.trustSignals
      .slice(0, 2)
      .join(" | ")}`;
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
    footer.textContent = `${deal.buySignal} | Trust ${Number(
      deal.trustScore || 0
    ).toFixed(1)} | Seller ${deal.seller} | ${deal.stampType.toUpperCase()} ${
      deal.stampCount
    } ct`;

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
      const nextKey = button.getAttribute("data-sort-key");
      if (listSort.key === nextKey) {
        listSort.direction = listSort.direction === "asc" ? "desc" : "asc";
      } else {
        listSort = { key: nextKey, direction: "desc" };
      }
      renderListDeals(lastDeals);
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
  renderDeals(lastDeals);
}

async function loadDeals() {
  refs.refreshBtn.disabled = true;
  refs.refreshBtn.textContent = "Loading...";
  try {
    const params = new URLSearchParams({
      sort: refs.sortBy.value,
      stampType: refs.stampType.value,
      condition: refs.condition.value,
      minDiscount: refs.minDiscount.value,
      minTrust: refs.minTrust.value,
      trustTier: refs.trustTier.value,
      q: refs.query.value,
      profitableOnly: refs.profitableOnly.checked ? "true" : "false",
      useMock: refs.useMock.checked ? "true" : "false",
      forceEbayRefresh: refs.forceEbayRefresh.checked ? "true" : "false",
    });
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
  } catch (error) {
    refs.barBoard.classList.add("hidden");
    refs.listView.classList.add("hidden");
    refs.grid.classList.remove("hidden");
    refs.grid.innerHTML = `<div class="empty">${error.message}</div>`;
  } finally {
    refs.refreshBtn.disabled = false;
    refs.refreshBtn.textContent = "Refresh Deals";
  }
}

refs.refreshBtn.addEventListener("click", loadDeals);
refs.viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.getAttribute("data-view-mode");
    setViewMode(mode || "cards");
  });
});
refs.barThreshold.addEventListener("input", () => {
  if (currentViewMode === "bars") {
    renderDeals(lastDeals);
  }
});
window.addEventListener("load", loadDeals);
