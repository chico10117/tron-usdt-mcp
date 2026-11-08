// Offline test: a fake remote MCP server on localhost, the proxy spawned over stdio.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const seen = { authorization: [], meta: [] };
let httpServer;
let remoteUrl;

function buildRemote() {
  const server = new McpServer({ name: "fake-remote", version: "0.0.0" });
  server.registerTool(
    "check_tron_usdt_blacklist",
    { description: "fake", inputSchema: { address: z.string() } },
    async ({ address }, extra) => {
      seen.meta.push(extra._meta ?? null);
      return { content: [{ type: "text", text: JSON.stringify({ address, blacklisted: false }) }] };
    },
  );
  return server;
}

before(async () => {
  httpServer = createServer(async (req, res) => {
    seen.authorization.push(req.headers.authorization ?? null);
    if (req.headers.authorization === "Bearer bad") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid API key" }, id: null }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const server = buildRemote();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  remoteUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
});

after(() => httpServer?.close());

async function connectProxy(env) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../index.js", import.meta.url))],
      env: { PATH: process.env.PATH ?? "", TRON_USDT_MCP_URL: remoteUrl, ...env },
      stderr: "pipe",
    }),
  );
  return client;
}

test("forwards tools/list and tools/call, including _meta and the API key", async () => {
  const client = await connectProxy({ TRON_USDT_API_KEY: "usk_test_123" });
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["check_tron_usdt_blacklist"]);

    const meta = { "x402/payment": { x402Version: 2, payload: { signature: "0xsig" } } };
    const result = await client.callTool({ name: "check_tron_usdt_blacklist", arguments: { address: "T123" }, _meta: meta });
    assert.equal(JSON.parse(result.content[0].text).address, "T123");
    assert.deepEqual(seen.meta.at(-1), meta);
    assert.ok(seen.authorization.length > 0);
    assert.ok(seen.authorization.every((value) => value === "Bearer usk_test_123"));
  } finally {
    await client.close();
  }
});

test("sends no Authorization header without an API key", async () => {
  seen.authorization.length = 0;
  const client = await connectProxy({});
  try {
    await client.listTools();
    assert.ok(seen.authorization.length > 0);
    assert.ok(seen.authorization.every((value) => value === null));
  } finally {
    await client.close();
  }
});

test("returns a tool error when the remote is unreachable", async () => {
  const client = await connectProxy({ TRON_USDT_MCP_URL: "http://127.0.0.1:1/mcp" });
  try {
    const result = await client.callTool({ name: "check_tron_usdt_blacklist", arguments: { address: "T123" } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "REMOTE_UNAVAILABLE");
  } finally {
    await client.close();
  }
});

test("maps a rejected API key to a non-retryable INVALID_API_KEY error", async () => {
  const client = await connectProxy({ TRON_USDT_API_KEY: "bad" });
  try {
    const result = await client.callTool({ name: "check_tron_usdt_blacklist", arguments: { address: "T123" } });
    assert.equal(result.isError, true);
    const { error } = JSON.parse(result.content[0].text);
    assert.equal(error.code, "INVALID_API_KEY");
    assert.equal(error.retryable, false);
    await assert.rejects(client.listTools(), /rejected TRON_USDT_API_KEY/);
  } finally {
    await client.close();
  }
});

test("refuses a non-https remote URL", async () => {
  await assert.rejects(connectProxy({ TRON_USDT_MCP_URL: "http://example.com/mcp" }));
});
