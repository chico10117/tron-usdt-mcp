---
name: tron-usdt-risk
description: Check a TRON address before accepting or sending USDT (TRC20). Use when a user asks whether a TRON wallet is frozen or blacklisted by Tether, is on the OFAC sanctions list, or is risky to trade with in a P2P or OTC deal. Calls the tron-usdt-risk MCP server.
---

# TRON USDT risk check

Use the `tron-usdt-risk` MCP server (`https://usdt.chikocorp.com/mcp`) to answer questions about one public TRON address at a time.

## Pick the tool

| Question | Tool | Cost |
| --- | --- | --- |
| "Is this address frozen by Tether?" / "Can this wallet still move USDT?" | `check_tron_usdt_blacklist` | Free, daily limit per caller |
| "Is it sanctioned or reported for scams?" | `screen_tron_address` | 1 credit or $0.10 via x402 |
| "Is it safe to trade with?" / full counterparty review | `tron_usdt_aml_report` | 1 credit or $1.00 via x402 |

Start with the free check. Offer the paid tools only when the user wants more than freeze status.

## Rules

- Only public `T...` addresses (34 characters). Never ask for a seed phrase or private key.
- Report freeze status and OFAC status as two separate facts. A clean result means "not listed at the time of the check", not "safe".
- If the freeze result is `inconclusive`, say the sources disagreed or were unavailable and suggest checking again later.
- The risk score is an evidence summary for human review, not an accept or reject decision.
- TRON only: a TRON result says nothing about the same funds on Ethereum or other chains.

## More

- Setup for Claude, Cursor and VS Code: https://usdt.chikocorp.com/mcp-server
- Scoring method: https://usdt.chikocorp.com/methodology
- Credits and API keys: https://usdt.chikocorp.com/pricing
