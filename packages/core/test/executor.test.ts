import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { RAW_REQUEST_TOOL_NAME, executeApiTool, executeRawRequest, sanitizeInputSchema } from "../src/executor.js";
import { ALL_TOOL_TAGS, getPresetTags } from "../src/presets.js";
import { generatedTools } from "../src/tools.js";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
let server: http.Server;
let config: { baseUrl: string; pat: string };
let seen: Seen[] = [];
let reply: (res: http.ServerResponse, attempt: number) => void;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      reply(res, seen.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/`, pat: "token" };
});
after(() => server.close());
beforeEach(() => {
  seen = [];
  reply = (res) => {
    res.setHeader("content-type", "application/vnd.api+json");
    res.end('{"data":[]}');
  };
});

const tool = (name: string) => {
  const definition = generatedTools.find((t) => t.name === name);
  assert.ok(definition, name);
  return definition;
};
const call = (name: string, args: Record<string, unknown>) => executeApiTool(name, tool(name), args, config);
const parsed = (result: any) => JSON.parse(result.content[0].text);

test("schema keys, names and tags are valid for every tool", () => {
  const keyPattern = /^[a-zA-Z0-9_.-]{1,64}$/;
  const walk = (node: any) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const key of Object.keys(node.properties ?? {})) assert.match(key, keyPattern);
      Object.values(node).forEach(walk);
    }
  };
  assert.ok(generatedTools.length >= 244);
  assert.equal(new Set(generatedTools.map((t) => t.name)).size, generatedTools.length);
  for (const t of generatedTools) {
    assert.match(t.name, /^[a-z0-9_-]{1,64}$/);
    walk(sanitizeInputSchema(t.inputSchema));
    for (const tag of t.tags) assert.ok(ALL_TOOL_TAGS.includes(tag), tag);
  }
  assert.ok(getPresetTags("full").includes("bills") && getPresetTags("full").includes("raw"));
});

test("204 on delete is a success", async () => {
  reply = (res) => { res.statusCode = 204; res.end(); };
  const result = await call("delete_account", { id: "5" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parsed(result), { success: true, status: 204 });
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "/api/v1/accounts/5");
  assert.equal(seen[0].headers.authorization, "Bearer token");
});

test("date-only values reach Firefly instead of failing locally", async () => {
  const requestBody = { transactions: [{ type: "deposit", date: "2026-10-02", amount: "1", description: "x" }] };
  const result = await call("store_transaction", { requestBody });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(seen[0].body.toString()), requestBody);
  assert.equal(seen[0].headers["content-type"], "application/json");
});

test("422 surfaces field errors and is flagged", async () => {
  reply = (res) => {
    res.statusCode = 422;
    res.setHeader("content-type", "application/json");
    res.end('{"message":"invalid","errors":{"transactions.0.amount":["bad"]}}');
  };
  const result = await call("store_transaction", { requestBody: { transactions: [] } });
  assert.equal(result.isError, true);
  const body = parsed(result);
  assert.equal(body.status, 422);
  assert.deepEqual(body.errors, { "transactions.0.amount": ["bad"] });
});

test("bracket arrays repeat, other arrays are comma joined, numbers coerce", async () => {
  await call("insight_expense_total", { start: "2026-01-01", end: "2026-02-01", accounts: ["1", "2"] });
  const url = new URL(seen[0].url, "http://x");
  assert.deepEqual(url.searchParams.getAll("accounts[]"), ["1", "2"]);
  seen = [];
  const result = await call("get_accounts_ac", { types: ["asset", "cash"], limit: "5" });
  assert.equal(result.isError, undefined);
  const url2 = new URL(seen[0].url, "http://x");
  assert.equal(url2.searchParams.get("types"), "asset,cash");
  assert.equal(url2.searchParams.get("limit"), "5");
});

test("POST without body still sends a content type", async () => {
  reply = (res) => { res.statusCode = 204; res.end(); };
  const result = await call("fire_rule", { id: "1", start: "2026-01-01", end: "2026-02-01" });
  assert.equal(result.isError, undefined);
  assert.equal(seen[0].headers["content-type"], "application/json");
});

test("reads retry transient failures, writes never do", async () => {
  reply = (res, attempt) => {
    res.statusCode = attempt < 3 ? 503 : 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  };
  assert.equal((await call("list_account", {})).isError, undefined);
  assert.equal(seen.length, 3);
  seen = [];
  reply = (res) => { res.statusCode = 503; res.end("down"); };
  const result = await call("store_transaction", { requestBody: { transactions: [] } });
  assert.equal(result.isError, true);
  assert.equal(seen.length, 1);
});

test("missing required path parameter is rejected before any request", async () => {
  const result = await call("delete_account", {});
  assert.equal(result.isError, true);
  assert.equal(seen.length, 0);
});

test("binary responses are base64, CSV stays text, uploads decode base64", async () => {
  reply = (res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.from([0, 255, 1]));
  };
  const bin = parsed(await call("download_attachment", { id: "1" }));
  assert.equal(bin.encoding, "base64");
  assert.equal(bin.data, Buffer.from([0, 255, 1]).toString("base64"));
  reply = (res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.end("a,b\n1,2\n");
  };
  assert.equal(((await call("export_accounts", {})) as any).content[0].text, "a,b\n1,2\n");
  seen = [];
  reply = (res) => { res.statusCode = 204; res.end(); };
  await call("upload_attachment", { id: "1", requestBody: Buffer.from("hello").toString("base64") });
  assert.equal(seen[0].body.toString(), "hello");
  assert.equal(seen[0].headers["content-type"], "application/octet-stream");
});

test("raw request reaches any path and refuses traversal", async () => {
  const ok = await executeRawRequest({ method: "get", path: "/v1/preferences-list/x", query: { "a[]": [1, 2] } }, config);
  assert.equal(ok.isError, undefined);
  assert.equal(seen[0].url, "/api/v1/preferences-list/x?a%5B%5D=1&a%5B%5D=2");
  assert.equal(RAW_REQUEST_TOOL_NAME, "firefly_api_request");
  assert.equal((await executeRawRequest({ method: "GET", path: "/v1/../secret" }, config)).isError, true);
  assert.equal((await executeRawRequest({ method: "GET", path: "/oauth/token" }, config)).isError, true);
});
