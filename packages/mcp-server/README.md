# @aabxtract/programmable-mcp-server

MCP server exposing the [Programmable Market](https://programmable.market) API to
Claude Code, Cursor, Windsurf, and any other MCP client.

Nine tools. Only `list_custom_launches` and `get_launch_status` need an API key — the
other seven work with no configuration at all.

## Configure

```json
{
  "mcpServers": {
    "programmable": {
      "command": "npx",
      "args": ["@aabxtract/programmable-mcp-server"],
      "env": {
        "PROGRAMMABLE_API_KEY": "${env:PROGRAMMABLE_API_KEY}"
      }
    }
  }
}
```

Don't inline the key — project-scoped MCP configs get committed.

| Env var | Purpose |
|---|---|
| `PROGRAMMABLE_API_KEY` | Bearer key for the two authenticated tools. Optional. |
| `PROGRAMMABLE_CHAIN_ID` | Default chain. Defaults to `4663` (Robinhood Chain). |
| `PROGRAMMABLE_BASE_URL` | Override the public read API origin. |

## Tools

| Tool | Auth | Notes |
|---|---|---|
| `list_launches` | No | Returns `feedStatus` and a caveat about degraded coverage |
| `get_launch` | No | By token address + chain |
| `get_stock_paired_launches` | No | **Reports itself unsupported** — excluded from the public API |
| `list_modules` | No | **Derived** from launch records; no modules endpoint exists |
| `get_modules_by_family` | No | **Derived**; matches model ids and capability ids |
| `verify_token` | No | Reads verification off the launch record |
| `check_submission_gate` | No | API create gate, reported separately from legacy intake |
| `list_custom_launches` | **Yes** | Your launches + status; how you discover launch ids |
| `get_launch_status` | **Yes** | v4 custom launch lifecycle + `walletHandoffUrl` |

Full docs: see `BUILD_GUIDE.md` in the repository.
