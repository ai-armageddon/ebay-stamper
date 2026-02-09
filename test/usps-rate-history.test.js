const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseRateAnnouncement,
  mergeRateEvents,
  buildDailyRates,
} = require("../src/usps-rate-history");

test("parseRateAnnouncement extracts prices and date from announcement text", () => {
  const html = `
    <html>
      <body>
        <p>The Postal Service filed notice and the changes are scheduled to take effect Jan. 22, 2023.</p>
        <p>The new rates include a three-cent increase in the price of a First-Class Mail Forever stamp from 60 cents to 63 cents.</p>
        <p>A 1-ounce letter mailed to another country would increase to $1.45.</p>
      </body>
    </html>
  `;

  const parsed = parseRateAnnouncement(
    html,
    "https://about.usps.com/newsroom/national-releases/2022/1007-usps-announces-new-prices-for-2023.htm"
  );

  assert.equal(parsed.effectiveDate, "2023-01-22");
  assert.equal(parsed.domesticForever, 0.63);
  assert.equal(parsed.globalForever, 1.45);
});

test("parseRateAnnouncement infers effective year from URL when missing", () => {
  const html = `
    <html>
      <body>
        <p>These adjustments are scheduled to take effect Sunday, July 13.</p>
        <p>Letters (1 ounce): 73 cents (current), 78 cents (planned)</p>
        <p>International letters (1 ounce): $1.65 (current), $1.70 (planned)</p>
      </body>
    </html>
  `;

  const parsed = parseRateAnnouncement(
    html,
    "https://news.usps.com/2025/04/09/usps-recommends-new-prices-2/"
  );

  assert.equal(parsed.effectiveDate, "2025-07-13");
  assert.equal(parsed.domesticForever, 0.78);
  assert.equal(parsed.globalForever, 1.7);
});

test("mergeRateEvents deduplicates equal events and records conflicts", () => {
  const merged = mergeRateEvents([
    {
      effectiveDate: "2024-07-14",
      domesticForever: 0.73,
      globalForever: 1.65,
      sourceUrls: ["https://news.usps.com/2024/04/09/usps-recommends-new-prices/"],
      sourceType: "news-usps",
    },
    {
      effectiveDate: "2024-07-14",
      domesticForever: 0.73,
      globalForever: 1.65,
      sourceUrls: ["https://about.usps.com/newsroom/national-releases/2024/source.htm"],
      sourceType: "about-usps",
    },
    {
      effectiveDate: "2024-07-14",
      domesticForever: 0.74,
      globalForever: 1.65,
      sourceUrls: ["https://example.com/conflict"],
      sourceType: "unknown",
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceUrls.length, 2);
  assert.equal(merged[0].conflicts.length, 1);
});

test("buildDailyRates carries active prices across days", () => {
  const daily = buildDailyRates({
    rateChanges: [
      {
        effectiveDate: "2023-01-22",
        domesticForever: 0.63,
        globalForever: 1.45,
        sourceUrls: ["https://example.com/2023-01"],
      },
      {
        effectiveDate: "2023-07-09",
        domesticForever: 0.66,
        globalForever: 1.5,
        sourceUrls: ["https://example.com/2023-07"],
      },
    ],
    startDate: "2022-12-04",
    endDate: "2023-07-10",
    baselineRates: {
      domesticForever: 0.6,
      globalForever: 1.4,
    },
  });

  const startRow = daily.find((row) => row.date === "2022-12-04");
  const janRow = daily.find((row) => row.date === "2023-01-22");
  const julyRow = daily.find((row) => row.date === "2023-07-10");

  assert.equal(startRow.domesticForever, 0.6);
  assert.equal(janRow.domesticForever, 0.63);
  assert.equal(julyRow.domesticForever, 0.66);
  assert.equal(julyRow.globalForever, 1.5);
});
