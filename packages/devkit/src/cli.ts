#!/usr/bin/env node
/**
 * `programmable` — the single entry point.
 *
 *   npm install -g programmable-devkit
 *   programmable new my-hook --template creator-fee-hook --fee 3000
 *
 * A dispatcher over the three packages, so there is one command to learn instead of
 * three binaries to remember. Each subcommand delegates to the library API rather than
 * shelling out, which keeps errors typed and exit codes honest.
 */

import { basename } from "node:path";
import { checkPath, describeTemplates, scaffold, validateValue } from "create-programmable-hook";
import {
  HARD_BLOCK_COUNT,
  HOOK_PERMISSION_BITS,
  INVARIANTS,
  REQUIRED_SOLC,
} from "create-programmable-hook";
import { createClient } from "@programmable-devkit/sdk";

const VERSION = "0.1.0";

const USAGE = `programmable — devkit for Programmable Market on Robinhood Chain

Usage:
  programmable <command> [options]

Commands:
  new <name>        Scaffold a v4 hook project, wired for your agent
  check [path]      Check Solidity against the admission invariants (default ./src)
  profile           Print the pinned compiler, permission bits, and invariants
  doctor            Check your environment: key, API reachability, submission gate
  mcp               Run the MCP server on stdio
  templates         List templates as JSON

Run \`programmable new --help\` for template-specific options.

Docs: https://github.com/aabxtract/programmable-kit
`;

async function cmdNew(argv: string[]): Promise<void> {
  const templates = await describeTemplates();

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: programmable new <name> [--template <t>] [--no-mcp] [options]\n");
    for (const t of templates) {
      console.log(`  ${t.name} — ${t.description}`);
      for (const v of t.variables) {
        console.log(`      ${v.flag.padEnd(12)} ${v.prompt}`);
      }
      console.log("");
    }
    return;
  }

  const templateIndex = argv.indexOf("--template");
  const template =
    templateIndex === -1 ? templates[0]?.name ?? "buyback-hook" : argv[templateIndex + 1];

  if (template === undefined) throw new Error("--template needs a value");

  const manifest = templates.find((t) => t.name === template);
  if (manifest === undefined) {
    throw new Error(
      `Unknown template "${template}". Available: ${templates.map((t) => t.name).join(", ")}`,
    );
  }

  const byFlag = new Map(manifest.variables.map((v) => [v.flag, v]));
  const values: Record<string, string> = {};
  let name: string | undefined;
  let mcp = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--template") {
      i += 1;
      continue;
    }
    if (arg === "--no-mcp") {
      mcp = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const variable = byFlag.get(arg);
      if (variable === undefined) {
        throw new Error(
          `Unknown option "${arg}" for ${template}. Valid: ${[...byFlag.keys()].join(", ")}`,
        );
      }
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("-")) {
        throw new Error(`${arg} needs a value (${variable.prompt}).`);
      }
      values[variable.key] = validateValue(variable, raw);
      i += 1;
      continue;
    }
    name ??= arg;
  }

  if (name === undefined) throw new Error("Usage: programmable new <name>");

  const result = await scaffold(name, { template, values, mcp });
  const check = await checkPath(`${result.target}/src`);

  console.log(`\n  ${result.manifest.title} — ${basename(result.target)}\n`);
  console.log(`  ${result.target}\n`);
  console.log(
    check.ok
      ? `  Guardrail check: PASS (${check.warnings} warning(s))\n`
      : `  Guardrail check: ${check.blocks} hard block(s) — template bug, please report\n`,
  );

  if (result.unresolved.length > 0) {
    console.log("  Still TODO in programmable-launch.config.json:");
    for (const v of result.unresolved) console.log(`    ${v.key.padEnd(16)} ${v.prompt}`);
    console.log("");
  }

  console.log("  Next:");
  console.log(`    cd ${name} && npm install`);
  console.log("    npm run setup    # forge install, pinned to verified tags");
  console.log("    cp .env.example .env    # add your API key");
  console.log("    programmable check\n");

  if (!check.ok) process.exitCode = 1;
}

async function cmdCheck(argv: string[]): Promise<void> {
  const target = argv.find((a) => !a.startsWith("-")) ?? "./src";
  const json = argv.includes("--json");

  const result = await checkPath(target);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (result.filesChecked.length === 0) {
    console.log(`No .sol files found under ${target}`);
    return;
  }

  console.log(`\nprogrammable check — ${result.filesChecked.length} file(s)\n`);

  for (const f of result.findings) {
    console.log(
      `  ${f.severity === "block" ? "BLOCK" : "warn "} ${f.id}  ${f.file}:${f.line}  ${f.title}`,
    );
    console.log(`        ${f.detail}`);
    if (f.invariant !== undefined) console.log(`        invariant: "${f.invariant}"`);
    console.log("");
  }

  if (result.ok && result.warnings === 0) {
    console.log("  No findings. Nothing here would hard-block at submission.\n");
  } else {
    console.log(`  ${result.blocks} hard block(s), ${result.warnings} warning(s)\n`);
  }

  if (!result.ok) process.exitCode = 1;
}

function cmdProfile(): void {
  console.log("\nProgrammable v4 admission profile (robinhood-mainnet)\n");
  console.log(`  compiler     ${REQUIRED_SOLC}`);
  console.log(`  hard blocks  ${HARD_BLOCK_COUNT}`);
  console.log("\n  Hook permission bits:");
  for (const [name, bit] of Object.entries(HOOK_PERMISSION_BITS)) {
    const isFlag = bit <= 3;
    console.log(`    ${String(bit).padStart(2)}  ${name}${isFlag ? "   (flag, not a callback)" : ""}`);
  }
  console.log("\n  Invariants enforced locally:");
  for (const [key, text] of Object.entries(INVARIANTS)) {
    console.log(`    ${key}\n      ${text}`);
  }
  console.log("");
}

/**
 * Environment check.
 *
 * Answers the question people actually have before submitting: is my key working, is
 * the platform up, and is the gate open — in that order, because each answer changes
 * whether the next one matters.
 */
async function cmdDoctor(): Promise<void> {
  console.log("\nprogrammable doctor\n");

  const client = createClient();
  let failed = 0;

  console.log(`  node         ${process.version}`);
  console.log(`  chain        ${client.chainId}`);
  console.log(`  api          ${client.baseUrl}`);
  console.log(
    `  api key      ${client.hasApiKey ? "configured" : "absent (public reads still work)"}`,
  );
  console.log("");

  try {
    const gate = await client.discovery.getSubmissionStatus();
    console.log(
      `  PASS submission gate    api create ${gate.apiCreateOpen ? "OPEN" : "CLOSED"}`,
    );
    if (!gate.apiCreateOpen) {
      console.log("       The create gate is closed — don't spend quota submitting.");
    }
  } catch (error) {
    console.log(`  FAIL submission gate    ${describe(error)}`);
    failed += 1;
  }

  try {
    const feed = await client.launches.listPage({ limit: 1 });
    const note =
      feed.status === "live"
        ? ""
        : "  (absence is not authoritative while degraded)";
    console.log(`  PASS launch feed        ${feed.status}${note}`);
  } catch (error) {
    console.log(`  FAIL launch feed        ${describe(error)}`);
    failed += 1;
  }

  if (client.hasApiKey) {
    try {
      const page = await client.launches.listCustomLaunches({ limit: 5 });
      console.log(`  PASS authenticated      ${page.launches.length} custom launch(es)`);
      for (const launch of page.launches.slice(0, 3)) {
        console.log(
          `       ${launch.launchId.slice(0, 20)}…  ${launch.status}` +
            (launch.failure ? `  ${launch.failure.code}` : ""),
        );
      }
    } catch (error) {
      console.log(`  FAIL authenticated      ${describe(error)}`);
      failed += 1;
    }
  } else {
    console.log("  --   authenticated      skipped, no PROGRAMMABLE_API_KEY");
  }

  console.log(failed === 0 ? "\n  Ready.\n" : `\n  ${failed} check(s) failed.\n`);
  if (failed > 0) process.exitCode = 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 90) : String(error).slice(0, 90);
}

async function cmdMcp(): Promise<void> {
  // The server owns stdio from here; it never returns.
  await import("@programmable-devkit/mcp-server/dist/index.js");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }

  try {
    switch (command) {
      case "new":
      case "create":
        await cmdNew(rest);
        break;
      case "check":
        await cmdCheck(rest);
        break;
      case "profile":
        cmdProfile();
        break;
      case "doctor":
        await cmdDoctor();
        break;
      case "mcp":
        await cmdMcp();
        break;
      case "templates":
        console.log(JSON.stringify(await describeTemplates(), null, 2));
        break;
      default:
        console.error(`Unknown command "${command}".\n`);
        console.error(USAGE);
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
