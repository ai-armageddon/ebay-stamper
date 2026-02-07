const test = require("node:test");
const assert = require("node:assert/strict");
const { handleDeals } = require("../app");

function createMockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

test("handleDeals returns arbitrage payload", async () => {
  const res = createMockResponse();
  const parsedUrl = new URL("http://localhost/api/deals?useMock=true&sort=discount");

  await handleDeals({}, res, parsedUrl);
  const payload = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.ok(payload.rates);
  assert.ok(Array.isArray(payload.deals));
  assert.ok(payload.deals.length > 0);
});
