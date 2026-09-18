#!/usr/bin/env node
/**
 * MCP server end-to-end check.
 *
 * Spawns the built server over stdio, completes the handshake, lists its tools, and
 * calls the unauthenticated ones. This is the counterpart to `npm run smoke`: that one
 * proves the SDK can reach the API, this one proves the server speaks MCP correctly and
 * its tools return usable results.
 *
 *   npm run check:mcp
 *   npm run check:mcp -- --chain 1
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(here, "../packages/mcp-server/dist/index.js");

interface Call {
  name: string;
  args: Record<string, unknown>;
  /** Needs an API key; only run when one is configured. */
  auth?: boolean;
  /** An error result is the correct outcome for this call. */
  expectError?: boolean;
}

/** Tool calls to exercise, with the arguments to use. */
function callsFor(chainId: number, hasKey: boolean): Call[] {
  const calls: Call[] = [
    { name: "check_submission_gate", args: {} },
    { name: "list_launches", args: { chainId, limit: 2 } },
    { name: "list_modules", args: { chainId, maxPages: 1 } },
    { name: "get_modules_by_family", args: { family: "buyback", chainId } },
    { name: "get_stock_paired_launches", args: { symbol: "NVDA" }, expectError: true },
  ];

  if (hasKey) {
    calls.push({ name: "list_custom_launches", args: { chainId, limit: 3 }, auth: true });
  }

  return calls;
}

/** Tools we expect the server to advertise. */
const EXPECTED_TOOLS = [
  "list_launches",
  "get_launch",
  "get_stock_paired_launches",
  "list_modules",
  "get_modules_by_family",
  "verify_token",
  "check_submission_gate",
  "list_custom_launches",
  "get_launch_status",
];

/** `callTool` returns a union covering the legacy `toolResult` shape, so narrow loosely. */
function firstText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && (item as { type?: string }).type === "text",
  );
  return block?.text ?? "";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const chainIndex = argv.indexOf("--chain");
  const chainId = chainIndex === -1 ? 4663 : Number(argv[chainIndex + 1]);

  console.log("\nProgrammable DevKit — MCP server check\n");
  console.log(`  server : ${SERVER_ENTRY}`);
  console.log(`  chain  : ${chainId}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    // Inherit the environment so a configured API key is picked up, and let the
    // server's stderr banner through for visibility.
    env: process.env as Record<string, string>,
    stderr: "inherit",
  });

  const client = new Client({ name: "devkit-check", version: "0.1.0" });

  let failed = 0;

  try {
    await client.connect(transport);
    console.log("  PASS handshake");

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));

    if (missing.length > 0) {
      console.log(`  FAIL tools/list — missing: ${missing.join(", ")}`);
      failed += 1;
    } else {
      console.log(`  PASS tools/list  ${tools.length} tools advertised`);
    }

    console.log("");

    const hasKey = (process.env.PROGRAMMABLE_API_KEY ?? "").trim() !== "";
    if (!hasKey) console.log("  (no API key — authenticated tools not exercised)\n");

    for (const call of callsFor(chainId, hasKey)) {
      const result = await client.callTool({
        name: call.name,
        arguments: call.args,
      });

      const text = firstText(result);
      const isError = result.isError === true;

      // get_stock_paired_launches reports itself unsupported; an error there is the
      // correct behaviour, not a failure.
      const expectedError = call.expectError === true;

      if (isError === expectedError) {
        const summary = text.replace(/\s+/g, " ").slice(0, 68);
        console.log(
          `  PASS ${call.name.padEnd(26)} ${expectedError ? "(reported unsupported)" : summary}`,
        );
      } else {
        console.log(`  FAIL ${call.name.padEnd(26)} ${text.replace(/\s+/g, " ").slice(0, 90)}`);
        failed += 1;
      }
    }
  } finally {
    await client.close().catch(() => {});
  }

  console.log(failed === 0 ? "\nMCP server OK\n" : `\n${failed} MCP check(s) failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
