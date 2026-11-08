# tron-usdt-mcp

MCP server for **TRON USDT (TRC20) address risk**. It checks whether Tether has blacklisted (frozen) an address, screens it against sanctions lists and abuse reports, and builds a full AML report.

This package is a small stdio proxy. All the work happens on the hosted server at `https://usdt.chikocorp.com/mcp`, which you can also connect to directly over Streamable HTTP.

## Tools

| Tool | Price | What it returns |
|---|---|---|
| `check_tron_usdt_blacklist` | Free (daily limit per caller) | Live read of the USDT TRC20 contract: blacklisted or not |
| `screen_tron_address` | $0.10 with x402, or 1 credit | Freeze status, OFAC SDN and OpenSanctions matches, Chainabuse reports, explainable risk score |
| `tron_usdt_aml_report` | $1.00 with x402, or 1 credit | Everything in the screen, plus Tether freeze history, 1-hop counterparty exposure and tracing, and a short summary |

Each tool takes one input: `{ "address": "T..." }`. Only send public TRON addresses. Never send seed phrases or private keys.

Failed paid calls are never charged. Each signed x402 payment pays for one call. A failed free check still counts toward the daily limit.

## Paying for the paid tools

Pick one of these:

- **API key (credits).** Create a key with the `screen:write` scope at <https://usdt.chikocorp.com/settings>. Each paid call costs 1 credit (1 credit = 1 USDT). Set it as `TRON_USDT_API_KEY` here, or send `Authorization: Bearer <key>` when you connect to the remote server directly.
- **x402 (USDC on Base).** Call without an API key. The first call returns a `PaymentRequired` result (`isError: true`, x402 v2 payload in `structuredContent`). Sign the payment and retry with it in `_meta["x402/payment"]`. Clients built on [`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp) do this automatically.

## Install

### Remote (no install)

Claude Code:

```bash
claude mcp add --transport http tron-usdt-risk https://usdt.chikocorp.com/mcp
# with an API key for the paid tools:
claude mcp add --transport http tron-usdt-risk https://usdt.chikocorp.com/mcp --header "Authorization: Bearer usk_live_..."
```

Any client that takes a JSON config:

```json
{
  "mcpServers": {
    "tron-usdt-risk": {
      "type": "http",
      "url": "https://usdt.chikocorp.com/mcp",
      "headers": { "Authorization": "Bearer usk_live_..." }
    }
  }
}
```

Leave out `headers` to use only the free tool, or to pay per call with x402. A wrong key gets HTTP 403 on every request, so remove the header rather than leaving a bad key in place.

The server takes one JSON-RPC message per request (no batching). Limits: 60 requests a minute and 50 free checks a day, counted per API-key user, or per IP address when there's no key. Hosted clients that share an IP address also share those limits, so add an API key to get your own.

### Local stdio (this package)

```json
{
  "mcpServers": {
    "tron-usdt-risk": {
      "command": "npx",
      "args": ["-y", "tron-usdt-mcp"],
      "env": { "TRON_USDT_API_KEY": "usk_live_..." }
    }
  }
}
```

| Variable | Required | Default |
|---|---|---|
| `TRON_USDT_API_KEY` | No | Not set: free tool plus x402 only. A wrong key blocks every tool, including the free one (`INVALID_API_KEY`) |
| `TRON_USDT_MCP_URL` | No | `https://usdt.chikocorp.com/mcp` (https only; http only for localhost) |

### Docker

```bash
docker build -t tron-usdt-mcp .
docker run -i --rm -e TRON_USDT_API_KEY tron-usdt-mcp
```

## Privacy

The proxy writes nothing to disk, and it never logs addresses, API keys or payment payloads. The hosted server does not log screened addresses either.

## Disclaimer

Results are informational screening built from public on-chain data and published lists. They are not legal advice, not attribution, and not an automated accept/reject decision. Freeze status is a point-in-time read. See the [methodology](https://usdt.chikocorp.com/methodology).

## License

MIT
