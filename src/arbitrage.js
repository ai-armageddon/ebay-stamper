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

function normalizeQuantityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9*+\-:/. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyIssueYear(value) {
  const currentYear = new Date().getUTCFullYear() + 2;
  return value >= 1900 && value <= currentYear;
}

function canUseQuantityCandidate(count, { strong = false, allowYear = false } = {}) {
  if (!Number.isFinite(count) || count <= 0 || count > 3000) {
    return false;
  }
  if (!allowYear && isLikelyIssueYear(count)) {
    return false;
  }
  if (!strong && count > 600) {
    return false;
  }
  return true;
}

function addQuantityCandidate(
  candidateMap,
  count,
  { score = 0, reason = "quantity hint", source = "title", strong = false, allowYear = false } = {}
) {
  if (!canUseQuantityCandidate(count, { strong, allowYear })) {
    return;
  }
  const next = {
    count,
    score,
    reason,
    source,
    strong,
  };
  const existing = candidateMap.get(count);
  if (!existing || next.score > existing.score) {
    candidateMap.set(count, next);
  }
}

function collectQuantityCandidates(text, { source = "title", sourceBoost = 0 } = {}) {
  const candidateMap = new Map();
  if (!text) {
    return candidateMap;
  }

  const multipliedPatterns = [
    /\b(\d{1,3})\s*(?:x|\*)\s*(\d{1,4})\s*(?:stamps?|ct|count|pcs?|pc)?\b/gi,
    /\b(\d{1,3})\s*(?:books?|booklets?|packs?|rolls?|coils?|sheets?|panes?)\s*(?:of|x)\s*(\d{1,4})\b/gi,
  ];
  for (const pattern of multipliedPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const units = Number(match[1]);
      const perUnit = Number(match[2]);
      const count = units * perUnit;
      addQuantityCandidate(candidateMap, count, {
        score: 94 + sourceBoost,
        reason: "multiplied quantity pattern",
        source,
        strong: true,
      });
    }
  }

  const explicitPatterns = [
    {
      regex: /\b(\d{1,4})\s*[- ]?(ct|count|pcs?|pc)\b/gi,
      baseScore: 90,
      reason: "explicit count marker",
      strong: true,
    },
    {
      regex: /\b(?:count|ct)\s*[:\-]?\s*(\d{1,4})\b/gi,
      baseScore: 86,
      reason: "reverse count marker",
      strong: true,
    },
    {
      regex: /\b(?:book(?:let)?|pack|sheet|pane|roll|coil|lot|bundle)\s*(?:of\s*)?(\d{1,4})\b/gi,
      baseScore: 84,
      reason: "package count pattern",
      strong: true,
    },
    {
      regex: /\b(\d{1,4})\s*[- ]?(?:book(?:let)?|pack|sheet|pane|roll|coil)\b/gi,
      baseScore: 78,
      reason: "leading package size",
      strong: true,
    },
    {
      regex: /\b(\d{1,4})\s*[- ]?stamps?\b/gi,
      baseScore: 72,
      reason: "stamps count hint",
      strong: false,
    },
  ];
  for (const patternConfig of explicitPatterns) {
    let match;
    while ((match = patternConfig.regex.exec(text)) !== null) {
      const count = Number(match[1]);
      addQuantityCandidate(candidateMap, count, {
        score: patternConfig.baseScore + sourceBoost,
        reason: patternConfig.reason,
        source,
        strong: patternConfig.strong,
      });
    }
  }

  const leadingQuantityMatch = text.match(
    /^(?:usps|u\s*s\s*p\s*s|forever|postage|stamps?|mail|authentic|genuine|sheet|booklet|book|pack|roll|coil|\W)*\s*(\d{1,4})\b/i
  );
  if (leadingQuantityMatch && leadingQuantityMatch[1]) {
    addQuantityCandidate(candidateMap, Number(leadingQuantityMatch[1]), {
      score: 58 + sourceBoost,
      reason: "leading number fallback",
      source,
      strong: false,
    });
  }

  if (/\bbooklet\b/.test(text)) {
    addQuantityCandidate(candidateMap, 20, {
      score: 44 + sourceBoost,
      reason: "booklet default size",
      source,
      strong: false,
    });
  }
  if (/\bcoil\b/.test(text)) {
    addQuantityCandidate(candidateMap, 100, {
      score: 46 + sourceBoost,
      reason: "coil default size",
      source,
      strong: false,
    });
  }
  if (/\b(sheet|pane)\b/.test(text)) {
    addQuantityCandidate(candidateMap, 20, {
      score: 40 + sourceBoost,
      reason: "sheet default size",
      source,
      strong: false,
    });
  }

  return candidateMap;
}

function scoreQuantityCandidate(candidate, { totalCost, uspsRate } = {}) {
  let score = Number(candidate.score || 0);
  if (candidate.count > 400 && !candidate.strong) {
    score -= 12;
  }
  if (candidate.count > 500 && !candidate.strong) {
    score -= 24;
  }

  const numericTotal = Number(totalCost);
  const numericRate = Number(uspsRate);
  if (
    Number.isFinite(numericTotal) &&
    numericTotal > 0 &&
    Number.isFinite(numericRate) &&
    numericRate > 0 &&
    candidate.count > 0
  ) {
    const impliedCostPerStamp = numericTotal / candidate.count;
    const ratio = impliedCostPerStamp / numericRate;
    if (ratio < 0.1) {
      score -= 65;
    } else if (ratio < 0.18) {
      score -= 40;
    } else if (ratio < 0.28) {
      score -= 20;
    } else if (ratio > 5) {
      score -= 10;
    }
  }

  return score;
}

function inferStampQuantity(options = {}) {
  const input =
    typeof options === "string" ? { title: options, description: "" } : options || {};
  const titleText = normalizeQuantityText(input.title || "");
  const descriptionText = normalizeQuantityText(input.description || "");
  const combinedText = [titleText, descriptionText].filter(Boolean).join(" ");

  const titleCandidates = collectQuantityCandidates(titleText, {
    source: "title",
    sourceBoost: 15,
  });
  const descriptionCandidates = collectQuantityCandidates(descriptionText, {
    source: "description",
    sourceBoost: 8,
  });
  const candidatesMap = new Map();
  for (const candidate of titleCandidates.values()) {
    addQuantityCandidate(candidatesMap, candidate.count, candidate);
  }
  for (const candidate of descriptionCandidates.values()) {
    addQuantityCandidate(candidatesMap, candidate.count, candidate);
  }

  if (candidatesMap.size === 0) {
    if (combinedText.includes("booklet")) {
      return {
        stampCount: 20,
        confidence: 0.24,
        source: "fallback",
        reason: "booklet default size",
      };
    }
    if (combinedText.includes("coil")) {
      return {
        stampCount: 100,
        confidence: 0.24,
        source: "fallback",
        reason: "coil default size",
      };
    }
    return {
      stampCount: 1,
      confidence: 0.1,
      source: "fallback",
      reason: "default quantity",
    };
  }

  const ranked = [...candidatesMap.values()]
    .map((candidate) => ({
      ...candidate,
      weightedScore: scoreQuantityCandidate(candidate, {
        totalCost: input.totalCost,
        uspsRate: input.uspsRate,
      }),
    }))
    .sort((left, right) => {
      if (right.weightedScore !== left.weightedScore) {
        return right.weightedScore - left.weightedScore;
      }
      return right.score - left.score;
    });

  let best = ranked[0];
  if (best && best.count <= 1) {
    const nearBestAlternative = ranked.find(
      (candidate) => candidate.count > 1 && candidate.weightedScore >= best.weightedScore - 14
    );
    if (nearBestAlternative) {
      best = nearBestAlternative;
    }
  }
  if (!best || best.weightedScore < 1) {
    return {
      stampCount: 1,
      confidence: 0.1,
      source: "fallback",
      reason: "default quantity",
    };
  }

  return {
    stampCount: best.count,
    confidence: roundCurrency(clamp((best.weightedScore - 25) / 75, 0.1, 0.99)),
    source: best.source,
    reason: best.reason,
  };
}

function inferStampCount(title, description = "") {
  return inferStampQuantity({
    title,
    description,
  }).stampCount;
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
  const uspsRate = stampType === "global" ? rates.globalForever : rates.domesticForever;
  const listingPrice = Number(listing.price || 0);
  const shippingCost = Number(listing.shippingCost || 0);
  const totalCost = Number(listing.totalCost || listingPrice + shippingCost);
  const quantity = inferStampQuantity({
    title: listing.title,
    description: listing.description,
    totalCost,
    uspsRate,
  });
  const stampCount = quantity.stampCount;
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
    stampCountConfidence: quantity.confidence,
    stampCountSource: quantity.source,
    stampCountReason: quantity.reason,
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
  inferStampQuantity,
  inferStampCount,
  computeSellerTrust,
  computeDeal,
  buildDeals,
  applyFilters,
  sortDeals,
  getSummary,
};
