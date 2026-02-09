const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inferStampType,
  inferStampCount,
  computeDeal,
  applyFilters,
  sortDeals,
  getSummary,
} = require("../src/arbitrage");

test("inferStampType identifies global listings", () => {
  assert.equal(inferStampType("USPS Global Forever stamp 10 ct"), "global");
  assert.equal(inferStampType("USPS Forever stamp booklet"), "domestic");
});

test("inferStampCount reads explicit counts and defaults", () => {
  assert.equal(inferStampCount("USPS Forever Stamps 20 ct"), 20);
  assert.equal(inferStampCount("USPS Coil"), 100);
  assert.equal(inferStampCount("single forever stamp"), 1);
});

test("computeDeal calculates savings and discount", () => {
  const listing = { title: "USPS Forever Stamps 20 ct", price: 10.0 };
  const rates = { domesticForever: 0.73, globalForever: 1.65 };
  const deal = computeDeal(listing, rates);
  assert.equal(deal.marketValue, 14.6);
  assert.equal(deal.savings, 4.6);
  assert.equal(deal.discountPct, 31.51);
  assert.equal(deal.underpricedDollars, 4.6);
  assert.equal(deal.underpricedPct, 31.51);
  assert.equal(deal.profitable, true);
});

test("filters and sort respect controls", () => {
  const rates = { domesticForever: 0.73, globalForever: 1.65 };
  const deals = [
    computeDeal(
      {
        title: "USPS Forever Stamps 20 ct",
        condition: "New",
        price: 11,
        listedAt: "2026-02-07T12:00:00Z",
      },
      rates
    ),
    computeDeal(
      {
        title: "USPS Global Forever 10 ct",
        condition: "New",
        price: 20,
        listedAt: "2026-02-06T12:00:00Z",
      },
      rates
    ),
    computeDeal(
      {
        title: "USPS Forever Stamps 20 ct",
        condition: "Used",
        price: 18,
        listedAt: "2026-02-05T12:00:00Z",
      },
      rates
    ),
  ];

  const filtered = applyFilters(deals, {
    stampType: "domestic",
    condition: "new",
    minDiscount: 10,
  });
  assert.equal(filtered.length, 1);

  const sortedRecent = sortDeals(deals, "recent");
  assert.equal(sortedRecent[0].listedAt, "2026-02-07T12:00:00Z");
});

test("trust filter and best sort prioritize credible profitable listings", () => {
  const rates = { domesticForever: 0.73, globalForever: 1.65 };
  const deals = [
    computeDeal(
      {
        title: "USPS Forever Stamps 20 ct",
        condition: "New",
        price: 11,
        sellerFeedbackPercentage: 99.9,
        sellerFeedbackScore: 3000,
        sellerTopRated: true,
        listedAt: "2026-02-07T12:00:00Z",
      },
      rates
    ),
    computeDeal(
      {
        title: "USPS Forever Stamps 20 ct",
        condition: "New",
        price: 9,
        sellerFeedbackPercentage: 92,
        sellerFeedbackScore: 8,
        sellerTopRated: false,
        listedAt: "2026-02-07T11:00:00Z",
      },
      rates
    ),
  ];

  const filtered = applyFilters(deals, { minTrust: 80, profitableOnly: true });
  assert.equal(filtered.length, 1);

  const sortedBest = sortDeals(filtered, "best");
  assert.equal(sortedBest[0].trustTier, "high");
});

test("summary reports best profitable listing", () => {
  const rates = { domesticForever: 0.73, globalForever: 1.65 };
  const deals = [
    computeDeal({ title: "USPS Forever 20 ct", price: 10 }, rates),
    computeDeal({ title: "USPS Global 10 ct", price: 20 }, rates),
  ];

  const summary = getSummary(deals);
  assert.equal(summary.profitableCount, 1);
  assert.ok(summary.bestDealTitle);
});
