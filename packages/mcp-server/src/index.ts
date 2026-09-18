#!/usr/bin/env node
/**
 * MCP server for the Programmable Market API.
 *
 * Exposes nine tools; only `list_custom_launches` and `get_launch_status` need an API
 * key. The rest work unauthenticated, so the server starts and stays useful with no key
 * configured.
 *
 * stdio transport: stdout is the protocol channel. All diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  API_KEY_ENV_VAR,
  CHAIN_ID,
  ProgrammableActionRequiredError,
  ProgrammableAuthError,
  ProgrammableConfigError,
  ProgrammableHttpError,
  ProgrammableNetworkError,
  ProgrammableResponseError,
  ProgrammableTimeoutError,
  ProgrammableUnsupportedError,
  createClient,
  type FeedStatus,
  type ProgrammableClient,
} from "@programmable-devkit/sdk";
import { z } from "zod";

const PACKAGE_VERSION = "0.1.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Explain what a degraded feed means for the answer.
 *
 * The API is explicit that "coverage gaps do not hide recognized records" but also that
 * absence is not authoritative while degraded. A model that doesn't know this will
 * confidently report "there is no such token" from an empty page, so every list result
 * carries this note.
 */
function feedCaveat(status: FeedStatus, count: number): string {
  if (status === "live") return "Feed is live; this result is complete.";
  if (status === "unavailable") {
    return (
      "Feed status is UNAVAILABLE for this chain. Records shown are real, but absence " +
      "proves nothing — do not conclude a token does not exist from this result."
    );
  }
  return (
    "Feed status is DEGRADED. The records shown are real and recognized, but coverage " +
    `is incomplete${count === 0 ? " and this page is empty" : ""} — absence is not ` +
    "authoritative."
  );
}

/**
 * Turn an SDK error into something the model can act on.
 *
 * The distinctions that matter: a wrong path needs fixing, a 5xx needs waiting, and an
 * unsupported operation needs neither — it needs the caller to stop asking.
 */
function describeError(error: unknown): string {
  if (error instanceof ProgrammableUnsupportedError) {
    return (
      `${error.message}\n\n` +
      "This is a permanent property of the public API. Retrying, changing arguments, " +
      "or supplying an API key will not help."
    );
  }

  if (error instanceof ProgrammableActionRequiredError) {
    return (
      `${error.message}\n\n` +
      "The launch is waiting on you, not on the server. Polling will not advance it."
    );
  }

  if (error instanceof ProgrammableAuthError) {
    return (
      `${error.message}\n\n` +
      "Only this tool and list_custom_launches need a key; the other seven work without one."
    );
  }

  if (error instanceof ProgrammableHttpError) {
    const lines = [`HTTP ${error.status} ${error.statusText} from ${error.url}`];

    if (error.isRateLimited) {
      lines.push(
        error.retryAfterMs !== undefined
          ? `Rate limited. Retry after ${Math.ceil(error.retryAfterMs / 1000)}s.`
          : "Rate limited, with no Retry-After header. Back off exponentially.",
      );
    } else if (error.status === 503) {
      lines.push(
        "The read model is temporarily unavailable. For point lookups this is also how " +
          "the API declines to confirm absence while degraded — it does NOT mean the " +
          "token is missing. Retry later.",
      );
    } else if (error.isTransient) {
      lines.push("Server-side and transient. Retry with backoff.");
    } else if (error.status === 404) {
      lines.push("The resource does not exist on this chain. Check the chainId.");
    } else if (error.status === 401 || error.status === 403) {
      lines.push(`Check that ${API_KEY_ENV_VAR} holds a valid, current key.`);
    }

    if (error.requestId !== undefined) lines.push(`Request id: ${error.requestId}`);

    const body = typeof error.body === "string" ? error.body : JSON.stringify(error.body);
    if (body && body !== "null") lines.push(`Response body: ${body.slice(0, 500)}`);

    return lines.join("\n");
  }

  if (error instanceof ProgrammableNetworkError) {
    return `${error.message}\n\nNo HTTP response was received. This is a network fault — retry.`;
  }

  if (error instanceof ProgrammableResponseError) {
    return (
      `${error.message}\n\nFirst 200 bytes: ${error.snippet}\n\n` +
      (error.reason === "shape"
        ? "The response parsed as JSON but wasn't the expected shape — the API schema " +
          "may have moved. This needs an SDK fix, not a retry."
        : "This path returned a non-JSON body, so it is not an API route.")
    );
  }

  if (error instanceof ProgrammableTimeoutError) {
    return `${error.message} The API may be slow or unreachable.`;
  }

  if (error instanceof ProgrammableConfigError) {
    return `Configuration problem: ${error.message}`;
  }

  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Wrap a handler so no tool can throw past the protocol boundary. */
function handler<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(describeError(error));
    }
  };
}

const chainIdSchema = z
  .number()
  .int()
  .optional()
  .describe(
    `Chain to query. Defaults to ${CHAIN_ID} (Robinhood Chain). Use 1 for Ethereum Mainnet.`,
  );

function registerTools(server: McpServer, client: ProgrammableClient): void {
  server.registerTool(
    "list_launches",
    {
      title: "List launches",
      description:
        "List token launches from the public Programmable v2 feed. Returns Classic and " +
        "Custom launches in one cursor-paginated envelope. Always check the returned " +
        "`feedStatus` before concluding anything from an empty result. No API key required.",
      inputSchema: {
        chainId: chainIdSchema,
        category: z.enum(["classic", "custom"]).optional()
          .describe("Stable public launch taxonomy."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Maximum launches per page."),
        cursor: z.string().optional()
          .describe("Continue the current page traversal. Do not combine with `after`."),
        after: z.string().optional()
          .describe("Resume token from a previous completed poll. Do not combine with `cursor`."),
      },
    },
    handler(async (args) => {
      const feed = await client.launches.listPage({
        ...(args.chainId !== undefined ? { chainId: args.chainId } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
      });

      return ok({
        count: feed.items.length,
        feedStatus: feed.status,
        caveat: feedCaveat(feed.status, feed.items.length),
        page: feed.page,
        snapshot: feed.snapshot,
        launches: feed.items,
      });
    }),
  );

  server.registerTool(
    "get_launch",
    {
      title: "Get launch by token address",
      description:
        "Fetch a single launch by token contract address and chain. A 503 here means " +
        "the API declines to confirm absence while degraded, not that the token is " +
        "missing. No API key required.",
      inputSchema: {
        address: z.string().min(1).describe("Token contract address, e.g. 0x1234..."),
        chainId: chainIdSchema,
      },
    },
    handler(async (args) =>
      ok(
        await client.launches.getByAddress(args.address, {
          ...(args.chainId !== undefined ? { chainId: args.chainId } : {}),
        }),
      ),
    ),
  );

  server.registerTool(
    "get_stock_paired_launches",
    {
      title: "Get stock-paired launches",
      description:
        "UNAVAILABLE. Stock-paired launches are explicitly excluded from the v2 " +
        "Developer API: no endpoint exposes the equity pairing and no launch record " +
        "carries a ticker field. This tool exists to say so rather than to return a " +
        "misleading empty list. Do not call it expecting data.",
      inputSchema: {
        symbol: z.string().optional().describe('Equity ticker, e.g. "NVDA".'),
      },
    },
    handler(async (args) => ok(await client.launches.getStockPaired(args.symbol))),
  );

  server.registerTool(
    "list_modules",
    {
      title: "List modules (derived)",
      description:
        "List modules DERIVED from indexed launch records — the platform publishes no " +
        "modules endpoint, so these are the distinct `model` ids and `capabilities` " +
        "that real launches declare on chain. A module nobody has launched with will " +
        "not appear. Costs several requests. No API key required.",
      inputSchema: {
        chainId: chainIdSchema,
        maxPages: z.number().int().min(1).max(20).optional()
          .describe("How many feed pages to scan. Default 20."),
      },
    },
    handler(async (args) => {
      const modules = await client.modules.list(
        { ...(args.chainId !== undefined ? { chainId: args.chainId } : {}) },
        { ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}) },
      );
      return ok({
        count: modules.length,
        derivation: "Distinct model id + version observed across indexed launches.",
        modules,
      });
    }),
  );

  server.registerTool(
    "get_modules_by_family",
    {
      title: "Get modules by family (derived)",
      description:
        "Filter the derived module list by family, model id, or capability. The " +
        "platform has no formal 'family' taxonomy, so this matches model ids and " +
        "capability strings case-insensitively. An empty result means no indexed " +
        "launch declares it. No API key required.",
      inputSchema: {
        family: z.string().min(1).describe('Family, model id, or capability, e.g. "buyback".'),
        chainId: chainIdSchema,
      },
    },
    handler(async (args) => {
      const modules = await client.modules.getByFamily(args.family, {
        ...(args.chainId !== undefined ? { chainId: args.chainId } : {}),
      });
      return ok({
        family: args.family,
        count: modules.length,
        note:
          modules.length === 0
            ? "No indexed launch declares this family, model id, or capability."
            : undefined,
        modules,
      });
    }),
  );

  server.registerTool(
    "verify_token",
    {
      title: "Verify token source",
      description:
        "Source verification status for a token. There is no standalone verification " +
        "endpoint — this reads the launch record's published verification fields. " +
        "Verdicts are queued | retrying | exact_match | needs_attention | unavailable. " +
        "There is no 'partial match'. No API key required.",
      inputSchema: {
        address: z.string().min(1).describe("Token contract address to verify."),
        chainId: chainIdSchema,
      },
    },
    handler(async (args) => {
      const result = await client.verify.verifyToken(args.address, {
        ...(args.chainId !== undefined ? { chainId: args.chainId } : {}),
      });
      return ok({
        ...result,
        note:
          result.sourceMatch === "unavailable"
            ? "The platform has published no source-verification status for this token. " +
              "That is not the same as 'unverified' — it means no verdict exists yet."
            : undefined,
      });
    }),
  );

  server.registerTool(
    "check_submission_gate",
    {
      title: "Check submission gate",
      description:
        "Check whether Programmable is accepting submissions. Reports the v4 API create " +
        "gate (what matters for programmatic submission) separately from the long-closed " +
        "legacy registry intake. Worth calling before a submission flow — one cheap " +
        "request saves a wasted expensive one. No API key required.",
      inputSchema: {},
    },
    handler(async () => {
      const gate = await client.discovery.getSubmissionStatus();
      return ok({
        ...gate,
        guidance: gate.apiCreateOpen
          ? "The v4 custom-launch API is accepting creates. The legacy registry intake " +
            "being closed does not block you."
          : "The API create gate is closed. Don't spend quota on a submission attempt.",
      });
    }),
  );

  server.registerTool(
    "list_custom_launches",
    {
      title: "List your custom launches",
      description:
        "List the custom launches belonging to your API key, newest first, with their " +
        "lifecycle status and any failure code. This is how you discover launch ids — " +
        `get_launch_status needs one. REQUIRES an API key in ${API_KEY_ENV_VAR}.`,
      inputSchema: {
        chainId: chainIdSchema,
        limit: z.number().int().min(1).max(50).optional().describe("Launches per page."),
        cursor: z.string().optional().describe("`nextCursor` from a previous page."),
      },
    },
    handler(async (args) => {
      const page = await client.launches.listCustomLaunches({
        ...(args.chainId !== undefined ? { chainId: args.chainId } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      });

      return ok({
        count: page.launches.length,
        nextCursor: page.nextCursor,
        launches: page.launches.map((launch) => ({
          launchId: launch.launchId,
          status: launch.status,
          failure: launch.failure,
          walletHandoffUrl: launch.walletHandoffUrl,
          expiresAt: launch.expiresAt,
          createdAt: launch.createdAt,
        })),
        note:
          "A `failure` on an action_required launch describes what to fix, not a dead " +
          "launch. Only status 'failed' is terminal.",
      });
    }),
  );

  server.registerTool(
    "get_launch_status",
    {
      title: "Get custom launch status",
      description:
        "Lifecycle status of a custom launch from the v4 API, including walletHandoffUrl " +
        "once the launch reaches `authorized`. States: received, validating, " +
        "action_required, authorized, awaiting_wallet_signature, wallet_action_required, " +
        `submitted, sequencer_soft_confirmed, ethereum_posted, finalized, failed. ` +
        `REQUIRES an API key in ${API_KEY_ENV_VAR}.`,
      inputSchema: {
        launchId: z.string().min(1).describe("Custom launch id."),
        chainId: chainIdSchema,
      },
    },
    handler(async (args) =>
      ok(
        await client.launches.getStatus(args.launchId, {
          ...(args.chainId !== undefined ? { chainId: args.chainId } : {}),
        }),
      ),
    ),
  );
}

async function main(): Promise<void> {
  let client: ProgrammableClient;
  try {
    client = createClient({
      ...(process.env.PROGRAMMABLE_CHAIN_ID
        ? { chainId: Number(process.env.PROGRAMMABLE_CHAIN_ID) }
        : {}),
    });
  } catch (error) {
    // A bad key is a startup failure, not a per-tool one — fail loudly and early.
    console.error(`[programmable-mcp] ${describeError(error)}`);
    process.exit(1);
  }

  const server = new McpServer(
    { name: "programmable", version: PACKAGE_VERSION },
    {
      instructions:
        `Tools for the Programmable Market API, defaulting to Robinhood Chain ` +
        `(chainId ${CHAIN_ID}). Two things to keep in mind: the launch feed is often ` +
        `"degraded", meaning absence is NOT authoritative — never conclude a token ` +
        "doesn't exist from an empty result; and stock-paired launches are excluded " +
        "from the public API entirely. Only get_launch_status requires an API key.",
    },
  );

  registerTools(server, client);

  console.error(
    `[programmable-mcp] v${PACKAGE_VERSION} chain ${client.chainId} on ${client.baseUrl} ` +
      `(api key: ${client.hasApiKey ? "configured" : "absent — 7 of 8 tools still work"})`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`[programmable-mcp] fatal: ${describeError(error)}`);
  process.exit(1);
});
