// Regression tests: one call's error or cancellation must not affect other in-flight calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const INDEX = fileURLToPath(new URL("../index.js", import.meta.url));
const events = [];
let httpServer;
let remoteUrl;

function buildRemote() {
  const server = new McpServer({ name: "fake-remote", version: "0.0.0" });
  server.registerTool("screen_tron_address", { description: "fake", inputSchema: { address: z.string() } }, async ({ address }) => {
    await new Promise((r) => setTimeout(r, 600));
    return { content: [{ type: "text", text: JSON.stringify({ address, ok: true }) }] };
  });
  return server;
}

before(async () => {
  httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (body?.params?.arguments?.address === "ERR") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests" }, id: null }));
      return;
    }
    const isCall = body?.method === "tools/call";
    let finished = false;
    res.on("finish", () => { finished = true; });
    res.on("close", () => { if (isCall) events.push({ address: body.params.arguments.address, completed: finished }); });
    const server = buildRemote();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  remoteUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
});

after(() => httpServer?.close());

async function connectProxy() {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [INDEX],
    env: { PATH: process.env.PATH ?? "", TRON_USDT_MCP_URL: remoteUrl },
    stderr: "pipe",
  }));
  return client;
}

test("a remote error on one call leaves a concurrent call intact", async () => {
  const client = await connectProxy();
  try {
    await client.listTools(); // warm the proxy's remote client
    const slow = client.callTool({ name: "screen_tron_address", arguments: { address: "TSLOW" } });
    await new Promise((r) => setTimeout(r, 150));
    const err = await client.callTool({ name: "screen_tron_address", arguments: { address: "ERR" } });
    assert.equal(JSON.parse(err.content[0].text).error.code, "RATE_LIMITED");
    const slowResult = await slow;
    assert.ok(!slowResult.isError);
    assert.equal(JSON.parse(slowResult.content[0].text).ok, true);
    assert.deepEqual(events.find((e) => e.address === "TSLOW"), { address: "TSLOW", completed: true });
  } finally {
    await client.close();
  }
});

test("cancelling one call leaves other concurrent calls intact", async () => {
  events.length = 0;
  const client = await connectProxy();
  try {
    await client.listTools();
    const ac = new AbortController();
    const a = client.callTool({ name: "screen_tron_address", arguments: { address: "TA" } }, undefined, { signal: ac.signal }).catch((e) => e);
    const b = client.callTool({ name: "screen_tron_address", arguments: { address: "TB" } });
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await a;
    const bResult = await b;
    assert.ok(!bResult.isError);
    assert.equal(JSON.parse(bResult.content[0].text).ok, true);
  } finally {
    await client.close();
  }
});
