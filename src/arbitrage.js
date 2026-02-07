function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function inferStampType(title) {
  const text = String(title || "").toLowerCase();
  if (text.includes("global") || text.includes("international")) {
    return "global";
  }
  return "domestic";
}

function inferStampCount(title) {
  const text = String(title || "").toLowerCase();
  const countMatch = text.match(/(\d{1,4})\s*(?:ct|count|stamps?|pcs?|pc)\b/i);
  if (countMatch) {
    return Number(countMatch[1]);
  }

  const ofMatch = text.match(/\b(?:book|booklet|pack|sheet|lot|coil)\s*(?:of)?\s*(\d{1,4})\b/i);
  if (ofMatch) {
    return Number(ofMatch[1]);
  }

  if (text.includes("booklet")) {
    return 20;
  }
  if (text.includes("coil")) {
    return 100;
  }
  return 1;
}

function computeDeal(listing, rates) {
  const stampType = inferStampType(listing.title);
  const stampCount = inferStampCount(listing.title);
  const uspsRate = stampType === "global" ? rates.globalForever : rates.domesticForever;
  const listingPrice = Number(listing.price || 0);
  const marketValue = roundCurrency(uspsRate * stampCount);
  const savings = roundCurrency(marketValue - listingPrice);
  const discountPct = marketValue > 0 ? roundCurrency((savings / marketValue) * 100) : 0;
  const score = discountPct + (savings > 0 ? 5 : -5);

  return {
    ...listing,
    stampType,
    stampCount,
    uspsRate: roundCurrency(uspsRate),
    marketValue,
    savings,
    discountPct,
    profitable: savings > 0,
    score: roundCurrency(score),
  };
}

function buildDeals(listings, rates) {
  return listings.map((listing) => computeDeal(listing, rates));
}

function applyFilters(deals, filters = {}) {
  const { stampType = "all", condition = "all", minDiscount = 0 } = filters;
  return deals.filter((deal) => {
    const stampMatch = stampType === "all" || deal.stampType === stampType;
    const conditionMatch =
      condition === "all" || String(deal.condition || "").toLowerCase() === condition.toLowerCase();
    const discountMatch = Number(deal.discountPct || 0) >= Number(minDiscount || 0);
    return stampMatch && conditionMatch && discountMatch;
  });
}

function sortDeals(deals, sortBy = "discount") {
  const output = [...deals];
  switch (sortBy) {
    case "price":
      output.sort((a, b) => a.price - b.price);
      break;
    case "recent":
      output.sort((a, b) => new Date(b.listedAt).getTime() - new Date(a.listedAt).getTime());
      break;
    case "discount":
    default:
      output.sort((a, b) => b.discountPct - a.discountPct);
      break;
  }
  return output;
}

function getSummary(deals) {
  const profitable = deals.filter((deal) => deal.profitable);
  const bestDeal = profitable.length > 0
    ? profitable.reduce((top, current) => (current.discountPct > top.discountPct ? current : top), profitable[0])
    : null;

  const avgDiscount =
    deals.length === 0
      ? 0
      : roundCurrency(
          deals.reduce((sum, deal) => sum + Number(deal.discountPct || 0), 0) / deals.length
        );

  return {
    profitableCount: profitable.length,
    avgDiscount,
    bestDealTitle: bestDeal ? bestDeal.title : null,
    bestDealDiscount: bestDeal ? bestDeal.discountPct : null,
  };
}

module.exports = {
  roundCurrency,
  inferStampType,
  inferStampCount,
  computeDeal,
  buildDeals,
  applyFilters,
  sortDeals,
  getSummary,
};
