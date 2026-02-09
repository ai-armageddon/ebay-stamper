const { refreshRateHistory, HISTORY_PATH } = require("../src/usps-rate-history");

async function main() {
  try {
    const payload = await refreshRateHistory();
    const latest = payload.dailyRates[payload.dailyRates.length - 1];
    // eslint-disable-next-line no-console
    console.log(
      `Wrote ${payload.dailyRates.length} rows to ${HISTORY_PATH}. Latest: ${latest.date} domestic=${latest.domesticForever} global=${latest.globalForever}`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to build USPS rate history:", error.message);
    process.exitCode = 1;
  }
}

main();
