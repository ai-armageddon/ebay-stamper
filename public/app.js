const refs = {
  grid: document.getElementById("listingGrid"),
  template: document.getElementById("cardTemplate"),
  stats: document.getElementById("stats"),
  meta: document.getElementById("meta"),
  sortBy: document.getElementById("sortBy"),
  stampType: document.getElementById("stampType"),
  condition: document.getElementById("condition"),
  minDiscount: document.getElementById("minDiscount"),
  query: document.getElementById("query"),
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
    statCard("Average Discount", `${Number(payload.summary.avgDiscount || 0).toFixed(2)}%`),
    statCard("USPS Domestic", formatMoney(payload.rates.domesticForever)),
    statCard("USPS Global", formatMoney(payload.rates.globalForever)),
  ].join("");
}

function setMeta(payload) {
  const best = payload.summary.bestDealTitle
    ? `${payload.summary.bestDealTitle} (${payload.summary.bestDealDiscount}% under USPS)`
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
    const pricing = node.querySelector(".pricing");
    const arbitrage = node.querySelector(".arbitrage");
    const metaLine = node.querySelector(".metaLine");
    const cta = node.querySelector(".cta");
    const badge = node.querySelector(".dealBadge");

    img.src = deal.image || "https://picsum.photos/seed/fallback/400/280";
    title.textContent = deal.title;
    seller.textContent = `Seller: ${deal.seller} | Condition: ${deal.condition}`;
    pricing.textContent = `Listing: ${formatMoney(deal.price)} | USPS value: ${formatMoney(deal.marketValue)}`;
    arbitrage.textContent = `Savings: ${formatMoney(deal.savings)} (${deal.discountPct}%)`;
    arbitrage.className = `arbitrage ${deal.profitable ? "good" : "bad"}`;
    metaLine.textContent = `${deal.stampType.toUpperCase()} | ${deal.stampCount} stamps`;
    cta.href = deal.itemWebUrl || "#";
    badge.textContent = makeBadge(deal);

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
      q: refs.query.value,
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
