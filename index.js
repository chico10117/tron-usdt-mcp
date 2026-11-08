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

function toolError(code, message, retryable) {
  const body = { error: { code, message, retryable } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// The remote answers 403 for a wrong or under-scoped API key, and 401 is treated the same.
function isAuthError(error) {
  const code = error?.code;
  return code === 401 || code === 403 || /\b(401|403)\b/.test(errorMessage(error));
}

function remoteFailure(error) {
  if (isAuthError(error)) {
    return toolError(
      "INVALID_API_KEY",
      "The remote server rejected TRON_USDT_API_KEY (wrong key or missing screen:write scope). Fix it or unset it to use the free tool and x402.",
      false,
    );
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
    remotePromise = null;
    const failure = remoteFailure(error);
    throw new McpError(ErrorCode.InternalError, failure.structuredContent.error.message);
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const remote = await connectRemote();
    // Forward params as-is so _meta (x402 payments) reaches the remote server.
    return await remote.callTool(request.params);
  } catch (error) {
    remotePromise = null;
    return remoteFailure(error);
  }
});

await server.connect(new StdioServerTransport());
