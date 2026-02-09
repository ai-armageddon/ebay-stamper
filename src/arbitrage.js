function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
  const groupedQuantityMatch = text.match(
    /\b(\d{1,3})\s*(?:rolls?|coils?|packs?|books?|booklets?|sheets?)\s*(?:of|x)\s*(\d{1,4})\b/i
  );
  if (groupedQuantityMatch) {
    const units = Number(groupedQuantityMatch[1]);
    const perUnit = Number(groupedQuantityMatch[2]);
    if (!Number.isNaN(units) && !Number.isNaN(perUnit) && units > 0 && perUnit > 0) {
      return units * perUnit;
    }
  }

  const explicitPatterns = [
    /\b(\d{1,4})\s*[- ]?(?:ct|count)\b/i,
    /\b(\d{1,4})\s*[- ]?(?:pack|pk|book(?:let)?|sheet|roll|coil)\b/i,
    /\b(?:book|booklet|pack|sheet|lot|coil|roll)\s*(?:of\s*)?(\d{1,4})\b/i,
    /\b(\d{1,4})\s*(?:stamps?|pcs?|pc)\b/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }
    const count = Number(match[1]);
    if (Number.isNaN(count) || count <= 0) {
      continue;
    }

    // Protect against issue year tokens like "2020 stamps".
    const currentYear = new Date().getUTCFullYear() + 1;
    const matchText = String(match[0] || "");
    const yearLikeWithStamps =
      count >= 1900 &&
      count <= currentYear &&
      /\bstamps?\b/i.test(matchText) &&
      !/\b(?:ct|count|pack|book|booklet|sheet|roll|coil|lot|pcs?|pc)\b/i.test(matchText);
    if (yearLikeWithStamps) {
      continue;
    }

    return count;
  }

  if (text.includes("booklet")) {
    return 20;
  }
  if (text.includes("coil")) {
    return 100;
  }
  return 1;
}

function computeSellerTrust(listing) {
  const feedbackPctRaw = Number(listing.sellerFeedbackPercentage);
  const feedbackScoreRaw = Number(listing.sellerFeedbackScore);
  const feedbackPct = Number.isFinite(feedbackPctRaw) ? feedbackPctRaw : null;
  const feedbackScore = Number.isFinite(feedbackScoreRaw) ? feedbackScoreRaw : null;
  const topRated = Boolean(listing.sellerTopRated);
  const signals = [];

  let trustScore = 35;

  if (feedbackPct === null) {
    signals.push("Feedback % unavailable");
  } else if (feedbackPct >= 99.5) {
    trustScore += 38;
    signals.push(`${feedbackPct.toFixed(1)}% positive feedback`);
  } else if (feedbackPct >= 98.5) {
    trustScore += 30;
    signals.push(`${feedbackPct.toFixed(1)}% positive feedback`);
  } else if (feedbackPct >= 97.0) {
    trustScore += 22;
    signals.push(`${feedbackPct.toFixed(1)}% positive feedback`);
  } else if (feedbackPct >= 95.0) {
    trustScore += 15;
    signals.push(`${feedbackPct.toFixed(1)}% positive feedback`);
  } else {
    trustScore += 6;
    signals.push(`${feedbackPct.toFixed(1)}% positive feedback`);
  }

  if (feedbackScore === null) {
    signals.push("Feedback volume unknown");
  } else if (feedbackScore >= 5000) {
    trustScore += 20;
    signals.push(`${feedbackScore} feedback score`);
  } else if (feedbackScore >= 1000) {
    trustScore += 16;
    signals.push(`${feedbackScore} feedback score`);
  } else if (feedbackScore >= 250) {
    trustScore += 12;
    signals.push(`${feedbackScore} feedback score`);
  } else if (feedbackScore >= 50) {
    trustScore += 8;
    signals.push(`${feedbackScore} feedback score`);
  } else if (feedbackScore >= 10) {
    trustScore += 4;
    signals.push(`${feedbackScore} feedback score`);
  } else {
    trustScore += 2;
    signals.push("Low feedback volume");
  }

  if (topRated) {
    trustScore += 10;
    signals.push("Top Rated Seller");
  }

  const normalized = roundCurrency(clamp(trustScore, 0, 100));
  const trustTier =
    normalized >= 85 ? "high" : normalized >= 65 ? "medium" : "low";

  return {
    trustScore: normalized,
    trustTier,
    trustSignals: signals,
  };
}

function computeOpportunityScore({ discountPct, savings, trustScore, listedAt }) {
  const discountComponent = clamp(Number(discountPct || 0) * 1.35, -40, 80);
  const savingsComponent = clamp(Number(savings || 0) * 2.0, -20, 40);
  const trustComponent = clamp(Number(trustScore || 0) * 0.32, 0, 32);
  const ageDays = Math.max(
    0,
    (Date.now() - new Date(listedAt || Date.now()).getTime()) / (1000 * 60 * 60 * 24)
  );
  const recencyComponent = clamp(10 - ageDays * 1.2, 0, 10);

  return roundCurrency(discountComponent + savingsComponent + trustComponent + recencyComponent);
}

function computeDeal(listing, rates) {
  const stampType = inferStampType(listing.title);
  const stampCount = inferStampCount(listing.title);
  const uspsRate = stampType === "global" ? rates.globalForever : rates.domesticForever;
  const listingPrice = Number(listing.price || 0);
  const shippingCost = Number(listing.shippingCost || 0);
  const totalCost = Number(listing.totalCost || listingPrice + shippingCost);
  const marketValue = roundCurrency(uspsRate * stampCount);
  const savings = roundCurrency(marketValue - totalCost);
  const discountPct = marketValue > 0 ? roundCurrency((savings / marketValue) * 100) : 0;
  const costPerStamp = stampCount > 0 ? roundCurrency(totalCost / stampCount) : 0;
  const perStampSavings = roundCurrency(uspsRate - costPerStamp);
  const perStampDiscountPct =
    uspsRate > 0 ? roundCurrency((perStampSavings / uspsRate) * 100) : 0;
  const trust = computeSellerTrust(listing);
  const opportunityScore = computeOpportunityScore({
    discountPct,
    savings,
    trustScore: trust.trustScore,
    listedAt: listing.listedAt,
  });
  const profitable = savings > 0;
  const dealTier =
    profitable && discountPct >= 25 && trust.trustScore >= 80
      ? "elite"
      : profitable && discountPct >= 12
      ? "strong"
      : profitable
      ? "watch"
      : "pass";
  const buySignal =
    dealTier === "elite"
      ? "BUY NOW"
      : dealTier === "strong"
      ? "STRONG BUY"
      : dealTier === "watch"
      ? "WATCH"
      : "PASS";

  return {
    ...listing,
    stampType,
    stampCount,
    listingPrice: roundCurrency(listingPrice),
    shippingCost: roundCurrency(shippingCost),
    totalCost: roundCurrency(totalCost),
    uspsRate: roundCurrency(uspsRate),
    marketValue,
    savings,
    underpricedDollars: savings,
    discountPct,
    underpricedPct: discountPct,
    costPerStamp,
    uspsPerStamp: roundCurrency(uspsRate),
    perStampSavings,
    perStampDiscountPct,
    profitable,
    trustScore: trust.trustScore,
    trustTier: trust.trustTier,
    trustSignals: trust.trustSignals,
    dealTier,
    buySignal,
    opportunityScore,
    score: opportunityScore,
  };
}

function buildDeals(listings, rates) {
  return listings.map((listing) => computeDeal(listing, rates));
}

function applyFilters(deals, filters = {}) {
  const {
    stampType = "all",
    condition = "all",
    minDiscount = 0,
    minTrust = 0,
    trustTier = "all",
    profitableOnly = false,
  } = filters;
  return deals.filter((deal) => {
    const stampMatch = stampType === "all" || deal.stampType === stampType;
    const conditionMatch =
      condition === "all" || String(deal.condition || "").toLowerCase() === condition.toLowerCase();
    const discountMatch = Number(deal.discountPct || 0) >= Number(minDiscount || 0);
    const trustMatch = Number(deal.trustScore || 0) >= Number(minTrust || 0);
    const trustTierMatch = trustTier === "all" || deal.trustTier === trustTier;
    const profitabilityMatch = !profitableOnly || deal.profitable;
    return (
      stampMatch &&
      conditionMatch &&
      discountMatch &&
      trustMatch &&
      trustTierMatch &&
      profitabilityMatch
    );
  });
}

function sortDeals(deals, sortBy = "best") {
  const output = [...deals];
  switch (sortBy) {
    case "best":
      output.sort((a, b) => {
        if (a.profitable !== b.profitable) {
          return a.profitable ? -1 : 1;
        }
        return b.opportunityScore - a.opportunityScore;
      });
      break;
    case "price":
      output.sort((a, b) => a.totalCost - b.totalCost);
      break;
    case "trust":
      output.sort((a, b) => b.trustScore - a.trustScore);
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
  const eliteDeals = profitable.filter((deal) => deal.dealTier === "elite");
  const bestDeal = profitable.length > 0
    ? profitable.reduce(
        (top, current) =>
          current.opportunityScore > top.opportunityScore ? current : top,
        profitable[0]
      )
    : null;

  const avgDiscount =
    deals.length === 0
      ? 0
      : roundCurrency(
          deals.reduce((sum, deal) => sum + Number(deal.discountPct || 0), 0) / deals.length
        );

  return {
    profitableCount: profitable.length,
    eliteCount: eliteDeals.length,
    avgDiscount,
    avgTrust:
      deals.length === 0
        ? 0
        : roundCurrency(
            deals.reduce((sum, deal) => sum + Number(deal.trustScore || 0), 0) / deals.length
          ),
    bestDealTitle: bestDeal ? bestDeal.title : null,
    bestDealDiscount: bestDeal ? bestDeal.discountPct : null,
    bestDealSignal: bestDeal ? bestDeal.buySignal : null,
    bestDealCostPerStamp: bestDeal ? bestDeal.costPerStamp : null,
    bestDealUspsPerStamp: bestDeal ? bestDeal.uspsPerStamp : null,
    bestDealTotalCost: bestDeal ? bestDeal.totalCost : null,
    bestDealMultiplier:
      bestDeal && Number(bestDeal.totalCost) > 0
        ? roundCurrency(Number(bestDeal.marketValue) / Number(bestDeal.totalCost))
        : null,
  };
}

module.exports = {
  roundCurrency,
  inferStampType,
  inferStampCount,
  computeSellerTrust,
  computeDeal,
  buildDeals,
  applyFilters,
  sortDeals,
  getSummary,
};
