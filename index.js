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

let remotePromise = null;

function connectRemote() {
  if (!remotePromise) {
    remotePromise = (async () => {
      const client = new Client({ name: "tron-usdt-mcp-proxy", version: VERSION });
      const transport = new StreamableHTTPClientTransport(remoteUrl, {
        requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      });
      await client.connect(transport);
      return client;
    })().catch((error) => {
      remotePromise = null;
      throw error;
    });
  }
  return remotePromise;
}

/** Drops the cached remote client (closing it) so the next call reconnects. */
function resetRemote() {
  const stale = remotePromise;
  remotePromise = null;
  stale?.then((client) => client.close()).catch(() => undefined);
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
    return toolError("REMOTE_TIMEOUT", "The remote server timed out. Unfinished paid calls are not charged.", false);
  }
  return toolError("REMOTE_UNAVAILABLE", `Could not reach ${remoteUrl.origin}: ${errorMessage(error)}`, true);
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

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  try {
    const remote = await connectRemote();
    return await remote.listTools(request.params);
  } catch (error) {
    resetRemote();
    const failure = remoteFailure(error);
    throw new McpError(ErrorCode.InternalError, failure.structuredContent.error.message);
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const remote = await connectRemote();
    // Forward params as-is so _meta (x402 payments) reaches the remote server; pass
    // the client's cancellation through. The remote never settles a call it did not finish.
    return await remote.callTool(request.params, undefined, { signal: extra.signal });
  } catch (error) {
    resetRemote();
    return remoteFailure(error);
  }
});

await server.connect(new StdioServerTransport());
