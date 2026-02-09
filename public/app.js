const refs = {
  grid: document.getElementById("listingGrid"),
  template: document.getElementById("cardTemplate"),
  stats: document.getElementById("stats"),
  meta: document.getElementById("meta"),
  sortBy: document.getElementById("sortBy"),
  stampType: document.getElementById("stampType"),
  condition: document.getElementById("condition"),
  minDiscount: document.getElementById("minDiscount"),
  minTrust: document.getElementById("minTrust"),
  trustTier: document.getElementById("trustTier"),
  query: document.getElementById("query"),
  profitableOnly: document.getElementById("profitableOnly"),
  useMock: document.getElementById("useMock"),
  refreshBtn: document.getElementById("refreshBtn"),
};

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function statCard(label, value) {
  return `
    <article class="statCard">
      <p class="statLabel">${label}</p>
      <p class="statValue">${value}</p>
    </article>
  `;
}

function setStats(payload) {
  refs.stats.innerHTML = [
    statCard("Profitable Listings", String(payload.summary.profitableCount || 0)),
    statCard("Elite Deals", String(payload.summary.eliteCount || 0)),
    statCard("Average Discount", `${Number(payload.summary.avgDiscount || 0).toFixed(2)}%`),
    statCard("Average Trust", `${Number(payload.summary.avgTrust || 0).toFixed(1)}/100`),
    statCard("USPS Domestic", formatMoney(payload.rates.domesticForever)),
    statCard("USPS Global", formatMoney(payload.rates.globalForever)),
  ].join("");
}

function setMeta(payload) {
  const best = payload.summary.bestDealTitle
    ? `${payload.summary.bestDealTitle} (${payload.summary.bestDealDiscount}% under USPS, ${payload.summary.bestDealSignal})`
    : "No profitable listing in current view";
  refs.meta.textContent = `Rates: ${payload.ratesSource} | Listings: ${payload.listingsSource} | Total Pulled: ${payload.totalListings} | Best: ${best}`;
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

function renderDeals(deals) {
  refs.grid.innerHTML = "";
  if (!deals.length) {
    refs.grid.innerHTML = '<div class="empty">No listings match your current filters.</div>';
    return;
  }

  deals.forEach((deal) => {
    const node = refs.template.content.cloneNode(true);
    const img = node.querySelector("img");
    const title = node.querySelector(".title");
    const seller = node.querySelector(".seller");
    const trust = node.querySelector(".trust");
    const signal = node.querySelector(".signal");
    const description = node.querySelector(".description");
    const pricing = node.querySelector(".pricing");
    const arbitrage = node.querySelector(".arbitrage");
    const metaLine = node.querySelector(".metaLine");
    const cta = node.querySelector(".cta");
    const badge = node.querySelector(".dealBadge");
    const card = node.querySelector(".card");

    img.src = deal.image || "https://picsum.photos/seed/fallback/400/280";
    title.textContent = deal.title;
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
    arbitrage.textContent = `Underpriced vs USPS: ${formatMoney(deal.underpricedDollars)} (${deal.underpricedPct}%)`;
    arbitrage.className = `arbitrage ${deal.profitable ? "good" : "bad"}`;
    metaLine.textContent = `${deal.stampType.toUpperCase()} | ${deal.stampCount} stamps | ${deal.trustSignals
      .slice(0, 2)
      .join(" | ")}`;
    cta.href = deal.itemWebUrl || "#";
    badge.textContent = makeBadge(deal);
    badge.className = `dealBadge ${badgeClass(deal)}`;
    card.classList.add(`tier-${badgeClass(deal)}`);

    refs.grid.appendChild(node);
  });
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
    });
    const response = await fetch(`/api/deals?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.details || payload.error || "Failed to load");
    }
    setStats(payload);
    setMeta(payload);
    renderDeals(payload.deals);
  } catch (error) {
    refs.grid.innerHTML = `<div class="empty">${error.message}</div>`;
  } finally {
    refs.refreshBtn.disabled = false;
    refs.refreshBtn.textContent = "Refresh Deals";
  }
}

refs.refreshBtn.addEventListener("click", loadDeals);
window.addEventListener("load", loadDeals);
