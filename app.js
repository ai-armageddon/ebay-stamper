require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { getUspsRates } = require("./src/usps-rates");
const { getListings } = require("./src/ebay-client");
const {
  buildDeals,
  applyFilters,
  sortDeals,
  getSummary,
} = require("./src/arbitrage");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": MIME_TYPES[".json"] });
  res.end(JSON.stringify(payload, null, 2));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

async function handleDeals(req, res, parsedUrl) {
  const sortBy = parsedUrl.searchParams.get("sort") || "discount";
  const stampType = parsedUrl.searchParams.get("stampType") || "all";
  const condition = parsedUrl.searchParams.get("condition") || "all";
  const minDiscount = Number(parsedUrl.searchParams.get("minDiscount") || 0);
  const query = parsedUrl.searchParams.get("q") || "usps forever stamps";
  const useMock = parseBoolean(parsedUrl.searchParams.get("useMock"), false);

  try {
    const rates = await getUspsRates();
    const listingsResult = await getListings({ query, useMock });
    const allDeals = buildDeals(listingsResult.listings, rates.rates);
    const filteredDeals = applyFilters(allDeals, {
      stampType,
      condition,
      minDiscount,
    });
    const sortedDeals = sortDeals(filteredDeals, sortBy);
    const summary = getSummary(sortedDeals);

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      rates: rates.rates,
      ratesSource: rates.source,
      listingsSource: listingsResult.source,
      totalListings: listingsResult.listings.length,
      summary,
      deals: sortedDeals,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Unable to build arbitrage feed",
      details: error.message,
    });
  }
}

function handleStatic(req, res, parsedUrl) {
  const safePath = path.normalize(parsedUrl.pathname).replace(/^(\.\.[/\\])+/, "");
  const targetPath =
    safePath === "/"
      ? path.join(PUBLIC_DIR, "index.html")
      : path.join(PUBLIC_DIR, safePath);

  if (!targetPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  sendFile(res, targetPath);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && parsedUrl.pathname === "/api/deals") {
      await handleDeals(req, res, parsedUrl);
      return;
    }

    if (req.method === "GET") {
      handleStatic(req, res, parsedUrl);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = {
  createServer,
  handleDeals,
};
