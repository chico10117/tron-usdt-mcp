#!/usr/bin/env node
// Local stdio proxy for the hosted TRON USDT Risk Checker MCP server.
// It forwards tools/list and tools/call to the remote Streamable HTTP endpoint.
// It never logs addresses, API keys or payment payloads.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "1.0.0";
const DEFAULT_URL = "https://usdt.chikocorp.com/mcp";

function resolveRemoteUrl(raw) {
  const url = new URL(raw || DEFAULT_URL);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("TRON_USDT_MCP_URL must use https (http is allowed only for localhost).");
  }
  if (url.username || url.password) {
    throw new Error("TRON_USDT_MCP_URL must not include credentials.");
  }
  return url;
}

const remoteUrl = resolveRemoteUrl(process.env.TRON_USDT_MCP_URL);
const apiKey = process.env.TRON_USDT_API_KEY?.trim() || null;

/**
 * Opens a fresh client for one call. The remote is stateless, so per-call clients cost
 * one extra initialize round trip and keep calls isolated: one call's error, rate limit
 * or cancellation never tears down another call's connection.
 */
async function withRemote(signal, fn) {
  const client = new Client({ name: "tron-usdt-mcp-proxy", version: VERSION });
  const transport = new StreamableHTTPClientTransport(remoteUrl, {
    requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
  });
  const onAbort = () => {
    void client.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect(transport, { signal });
    return await fn(client);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await client.close().catch(() => undefined);
  }
}

function toolError(code, message, retryable) {
  const body = { error: { code, message, retryable } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// The SDK's StreamableHTTPError carries the HTTP status as `code`.
function remoteFailure(error) {
  const status = typeof error?.code === "number" ? error.code : null;
  if (status === 401 || status === 403) {
    return toolError(
      "INVALID_API_KEY",
      "The remote server rejected TRON_USDT_API_KEY (wrong key or missing screen:write scope). Fix it or unset it to use the free tool and x402.",
      false,
    );
  }
  if (status === 429) {
    return toolError("RATE_LIMITED", "Too many requests to the remote server. Wait a minute and retry.", true);
  }
  if (status === 504) {
    // A paid call that ran out of time is not charged, but don't auto-retry a paid call blindly.
    return toolError(
      "REMOTE_TIMEOUT",
      "The remote server timed out. An unfinished paid call is not settled unless settlement had already started; check before paying again.",
      false,
    );
  }
  return toolError("REMOTE_UNAVAILABLE", `Remote call to ${remoteUrl.origin} failed: ${errorMessage(error)}`, true);
}

const server = new Server(
  { name: "tron-usdt-risk", title: "TRON USDT Risk Checker", version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      "Screens public TRON addresses for USDT (TRC20) risk. Only send public T-addresses, never seed phrases or private keys. "
      + "check_tron_usdt_blacklist is free. screen_tron_address and tron_usdt_aml_report are paid: set TRON_USDT_API_KEY "
      + "(1 credit per call) or pay per call with x402 via _meta[\"x402/payment\"]. Failed paid calls are never charged.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
  try {
    return await withRemote(extra.signal, (remote) => remote.listTools(request.params, { signal: extra.signal }));
  } catch (error) {
    const failure = remoteFailure(error);
    throw new McpError(ErrorCode.InternalError, failure.structuredContent.error.message);
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    // Forward params as-is so _meta (x402 payments) reaches the remote server. A client
    // cancel aborts only this call's HTTP request; the remote then skips settlement.
    return await withRemote(extra.signal, (remote) =>
      remote.callTool(request.params, undefined, { signal: extra.signal }),
    );
  } catch (error) {
    return remoteFailure(error);
  }
});

await server.connect(new StdioServerTransport());
