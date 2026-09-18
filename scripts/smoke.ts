#!/usr/bin/env node
/**
 * Endpoint smoke check.
 *
 * A clean build proves nothing about whether the SDK can reach the platform. This calls
 * each route once and reports which respond, so a broken assumption shows up as a table
 * rather than as a confusing failure halfway through building something.
 *
 *   npm run smoke
 *   npm run smoke -- --chain 1
 *   npm run smoke -- --base-url https://staging.example
 *   node --env-file=.env dist/smoke.js --key
 *
 * Exit code is 1 if any check fails, so this works in CI.
 */

import {
  CHAIN_ID,
  CUSTOM_LAUNCH_V4_CHAIN_ID,
  ProgrammableAuthError,
  ProgrammableConfigError,
  ProgrammableError,
  ProgrammableHttpError,
  ProgrammableNetworkError,
  ProgrammableResponseError,
  ProgrammableTimeoutError,
  ProgrammableUnsupportedError,
  createClient,
  type ProgrammableClient,
} from "@aabxtract/programmable-sdk";

/** Identifiers that will not exist. A 404 for these means the *route* is live. */
const SENTINEL_LAUNCH_ID = "00000000-0000-4000-8000-000000000000";
const SENTINEL_ADDRESS = "0x0000000000000000000000000000000000000000";

interface Context {
  client: ProgrammableClient;
  chainId: number;
  /**
   * A token address taken from the live feed, when one is available.
   *
   * Point lookups are probed with a real address rather than a sentinel because, while
   * the read model is degraded, the API answers 503 rather than 404 for unknown tokens
   * — "absence is not authoritative" is its documented stance. A sentinel therefore
   * can't distinguish a working route from a broken one.
   */
  sampleAddress?: string;
  /** A real launch id from the account, when a key is configured. */
  sampleLaunchId?: string;
}

interface Check {
  name: string;
  route: string;
  /** Needs an API key; skipped unless --key is passed. */
  auth?: boolean;
  /**
   * Treat a 404 as success. Only sound for item routes whose parent collection is also
   * checked — otherwise a 404 can't distinguish "absent resource" from "wrong path".
   */
  missingIsOk?: boolean;
  /** This operation is expected to be unsupported; report it, don't fail on it. */
  expectUnsupported?: boolean;
  /** Only valid on this chain; reported n/a elsewhere rather than run. */
  onlyChain?: number;
  run: (context: Context) => Promise<string>;
}

const CHECKS: Check[] = [
  {
    name: "discovery.getManifest()",
    route: "/.well-known/programmable.json",
    run: async ({ client }) => {
      const manifest = await client.discovery.getManifest();
      const chains = manifest.chains?.length ?? 0;
      return `schema ${manifest.schemaVersion ?? "?"}, ${chains} chains`;
    },
  },
  {
    name: "discovery.getStatus()",
    route: "/api/v2/status",
    run: async ({ client }) => {
      const status = await client.discovery.getStatus();
      return `service ${String(status["service"] ?? "?")}`;
    },
  },
  {
    name: "discovery.getSubmissionStatus()",
    route: "/.well-known (gate)",
    run: async ({ client }) => {
      const gate = await client.discovery.getSubmissionStatus();
      return `api create ${gate.apiCreateOpen ? "open" : "closed"}, legacy ${
        gate.legacyIntakeOpen ? "open" : "closed"
      }`;
    },
  },
  {
    name: "launches.listPage()",
    route: "/api/v2/launches",
    run: async ({ client, chainId }) => {
      const feed = await client.launches.listPage({ chainId, limit: 2 });
      return `${feed.items.length} items, feed ${feed.status}`;
    },
  },
  {
    name: "launches.getByAddress()",
    route: "/api/v2/launches/{chainId}/{token}",
    missingIsOk: true,
    run: async ({ client, chainId, sampleAddress }) => {
      const launch = await client.launches.getByAddress(
        sampleAddress ?? SENTINEL_ADDRESS,
        { chainId },
      );
      return `${launch.token?.symbol ?? launch.launchId.slice(0, 14)}`;
    },
  },
  {
    name: "launches.getStockPaired()",
    route: "(excluded from v2 API)",
    expectUnsupported: true,
    run: async ({ client }) => {
      await client.launches.getStockPaired("NVDA");
      return "unexpectedly succeeded";
    },
  },
  {
    name: "modules.list()  [derived]",
    route: "derived from /api/v2/launches",
    run: async ({ client, chainId }) => {
      const modules = await client.modules.list({ chainId }, { maxPages: 2 });
      return `${modules.length} distinct models`;
    },
  },
  {
    name: "verify.verifyToken()",
    route: "launch extensions.sourceVerification",
    run: async ({ client, chainId, sampleAddress }) => {
      const result = await client.verify.verifyToken(
        sampleAddress ?? SENTINEL_ADDRESS,
        { chainId },
      );
      return `sourceMatch ${result.sourceMatch}`;
    },
  },
  {
    name: "launches.listCustomLaunches()",
    route: "/v4/chains/{chainId}/custom-launches",
    auth: true,
    onlyChain: CUSTOM_LAUNCH_V4_CHAIN_ID,
    run: async ({ client, chainId }) => {
      const page = await client.launches.listCustomLaunches({ chainId, limit: 5 });
      return `${page.launches.length} launches`;
    },
  },
  {
    name: "launches.getStatus()",
    route: "/v4/chains/{chainId}/custom-launches/{id}",
    auth: true,
    missingIsOk: true,
    onlyChain: CUSTOM_LAUNCH_V4_CHAIN_ID,
    run: async ({ client, chainId, sampleLaunchId }) => {
      const status = await client.launches.getStatus(
        sampleLaunchId ?? SENTINEL_LAUNCH_ID,
        { chainId },
      );
      return `status ${status.status}`;
    },
  },
];

/**
 * `warn` is for service conditions — 429/5xx — as opposed to `fail`, which means the
 * route or shape is wrong. Conflating them sends you off editing correct paths because
 * the platform happened to be degraded, so they're counted separately.
 */
type Outcome = { kind: "pass" | "fail" | "warn" | "note"; detail: string };

async function runCheck(check: Check, context: Context): Promise<Outcome> {
  try {
    const detail = await check.run(context);
    return check.expectUnsupported
      ? { kind: "fail", detail: "expected unsupported, got a result" }
      : { kind: "pass", detail };
  } catch (error) {
    if (error instanceof ProgrammableUnsupportedError) {
      return check.expectUnsupported
        ? { kind: "note", detail: "unsupported by design" }
        : { kind: "fail", detail: "unexpectedly unsupported" };
    }

    if (error instanceof ProgrammableHttpError) {
      if (error.status === 404 && check.missingIsOk) {
        return { kind: "pass", detail: "404 route live, resource absent" };
      }
      if (error.isTransient) {
        return { kind: "warn", detail: `${error.status} ${error.statusText}` };
      }
      return { kind: "fail", detail: `${error.status} ${error.statusText}` };
    }
    if (error instanceof ProgrammableResponseError) {
      return { kind: "fail", detail: `bad ${error.reason}` };
    }
    if (error instanceof ProgrammableTimeoutError) {
      return { kind: "warn", detail: "timeout" };
    }
    if (error instanceof ProgrammableNetworkError) {
      return { kind: "warn", detail: "network fault, no response" };
    }
    if (error instanceof ProgrammableAuthError) {
      return { kind: "fail", detail: "no API key" };
    }
    if (error instanceof ProgrammableError) {
      return { kind: "fail", detail: error.message.slice(0, 40) };
    }
    return { kind: "fail", detail: String(error).slice(0, 40) };
  }
}

interface Args {
  key: boolean;
  baseUrl?: string;
  chainId: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { key: false, chainId: CHAIN_ID, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--key") result.key = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--base-url") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--base-url needs a value");
      result.baseUrl = value;
      i += 1;
    } else if (arg === "--chain") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value)) throw new Error("--chain needs a numeric chain id");
      result.chainId = value;
      i += 1;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: npm run smoke [-- <options>]\n\n" +
        "  --key            also probe the authenticated v4 endpoint\n" +
        `  --chain <id>     chain to probe (default ${CHAIN_ID}, Robinhood Chain)\n` +
        "  --base-url <url> override the public read API origin\n",
    );
    return;
  }

  let client: ProgrammableClient;
  try {
    client = createClient({
      chainId: args.chainId,
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
    });
  } catch (error) {
    const message =
      error instanceof ProgrammableConfigError ? error.message : String(error);
    console.error(`Could not create a client: ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nProgrammable DevKit — endpoint smoke check\n");
  console.log(`  discovery : ${client.origins["discovery"]}`);
  console.log(`  api       : ${client.origins["api"]}`);
  console.log(`  custom    : ${client.origins["customLaunch"]}`);
  console.log(`  chain     : ${args.chainId}`);
  console.log(
    `  api key   : ${client.hasApiKey ? "configured" : "absent"}` +
      (args.key && !client.hasApiKey ? "  (--key passed but no key found)" : ""),
  );
  console.log("");

  const context: Context = { client, chainId: args.chainId };

  // Grab a real address for the point-lookup checks. Best-effort: if the feed is empty
  // or down, those checks fall back to the sentinel and report whatever they get.
  try {
    const feed = await client.launches.listPage({ chainId: args.chainId, limit: 1 });
    const address = feed.items[0]?.token?.address;
    if (address !== undefined) context.sampleAddress = address;
  } catch {
    // The feed check below reports this properly; no need to fail twice.
  }

  if (context.sampleAddress === undefined) {
    console.log("  (no live launch on this chain — point lookups use a sentinel)\n");
  }

  // With a key, probe getStatus against a real launch rather than a sentinel: that
  // checks the response shape, not just that auth is accepted.
  if (args.key && client.hasApiKey && args.chainId === CUSTOM_LAUNCH_V4_CHAIN_ID) {
    try {
      const page = await client.launches.listCustomLaunches({
        chainId: args.chainId,
        limit: 1,
      });
      const launchId = page.launches[0]?.launchId;
      if (launchId !== undefined) context.sampleLaunchId = launchId;
    } catch {
      // The listCustomLaunches check reports this properly.
    }
  }

  const nameWidth = Math.max(...CHECKS.map((c) => c.name.length));
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const check of CHECKS) {
    if (check.onlyChain !== undefined && check.onlyChain !== args.chainId) {
      console.log(
        `  n/a  ${check.name.padEnd(nameWidth)}  v4 API is chain ${check.onlyChain} only`,
      );
      continue;
    }

    if (check.auth && !args.key) {
      console.log(`  --   ${check.name.padEnd(nameWidth)}  skipped (needs --key)`);
      continue;
    }

    const outcome = await runCheck(check, context);

    if (outcome.kind === "note") {
      console.log(`  n/a  ${check.name.padEnd(nameWidth)}  ${outcome.detail}`);
      continue;
    }

    if (outcome.kind === "pass") passed += 1;
    else if (outcome.kind === "warn") warned += 1;
    else failed += 1;

    const mark = { pass: "PASS", warn: "WARN", fail: "FAIL" }[outcome.kind];
    console.log(
      `  ${mark} ${check.name.padEnd(nameWidth)}  ${outcome.detail.padEnd(32)}  ${check.route}`,
    );
  }

  console.log(
    `\n${passed} passed, ${failed} failed, ${warned} degraded ` +
      `(${passed + failed + warned} checks)`,
  );

  if (warned > 0) {
    console.log(
      "\nWARN means the platform answered 429/5xx — a service condition, not a wrong\n" +
        "path. The API reports absence as non-authoritative while degraded. Rerun later.",
    );
  }

  if (failed > 0) {
    console.log(
      "\nFAIL means a path or response shape is wrong.\n" +
        "Edit ENDPOINTS in packages/sdk/src/types.ts, or pass --base-url, then rerun.",
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
