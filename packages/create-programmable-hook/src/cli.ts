#!/usr/bin/env node
/**
 * `create-programmable-hook` — scaffold a Uniswap v4 hook project for Programmable.
 *
 * The scaffolded project is checked by this command before it reports success, so a
 * template that drifts into a violation fails here rather than at submission.
 */

import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPath } from "./checker/index.js";
import {
  DEFAULT_TEMPLATE,
  describeTemplates,
  listTemplates,
  readTemplateManifest,
  scaffold,
  validateValue,
  type TemplateVariable,
} from "./scaffold.js";

export interface Args {
  projectName?: string;
  template: string;
  values: Record<string, string>;
  mcp: boolean;
  list: boolean;
  help: boolean;
}

/** Flags understood regardless of template. */
const BASE_FLAGS = new Set(["--template", "--list", "--no-mcp", "--help", "-h"]);

async function usage(): Promise<string> {
  const manifests = await describeTemplates();

  const templateHelp = manifests
    .map((m) => {
      const flags = m.variables
        .map((v) => `      ${v.flag.padEnd(12)} ${v.prompt}`)
        .join("\n");
      return `  ${m.name}\n      ${m.description}\n${flags}`;
    })
    .join("\n\n");

  return `create-programmable-hook — scaffold a Uniswap v4 hook for Programmable Market

Usage:
  create-programmable-hook <project-name> [options]

Options:
  --template <name>   Template to use (default: ${DEFAULT_TEMPLATE})
  --no-mcp            Skip .mcp.json (by default your agent is wired up)
  --list              List templates as JSON
  -h, --help          This message

Templates:

${templateHelp}

Examples:
  create-programmable-hook my-hook
  create-programmable-hook fees --template creator-fee-hook --fee 3000 --symbol MYT
`;
}

export async function parseArgs(argv: string[]): Promise<Args> {
  const args: Args = {
    template: DEFAULT_TEMPLATE,
    values: {},
    mcp: true,
    list: false,
    help: false,
  };

  // Template must be resolved first, since it determines which flags are valid.
  const templateIndex = argv.indexOf("--template");
  if (templateIndex !== -1) {
    const value = argv[templateIndex + 1];
    if (value === undefined) throw new Error("--template needs a value");
    args.template = value;
  }

  if (argv.includes("--help") || argv.includes("-h")) args.help = true;
  if (argv.includes("--list")) args.list = true;
  if (argv.includes("--no-mcp")) args.mcp = false;

  if (args.help || args.list) return args;

  const templates = await listTemplates();
  if (!templates.includes(args.template)) {
    throw new Error(
      `Unknown template "${args.template}". Available: ${templates.join(", ")}`,
    );
  }

  const manifest = await readTemplateManifest(args.template);
  const byFlag = new Map<string, TemplateVariable>(
    manifest.variables.map((v) => [v.flag, v]),
  );

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--template") {
      i += 1;
      continue;
    }
    if (BASE_FLAGS.has(arg)) continue;

    if (arg.startsWith("-")) {
      const variable = byFlag.get(arg);
      if (variable === undefined) {
        throw new Error(
          `Unknown option "${arg}" for template ${args.template}. ` +
            `Valid: ${[...byFlag.keys()].join(", ")}`,
        );
      }
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("-")) {
        throw new Error(`${arg} needs a value (${variable.prompt}).`);
      }
      args.values[variable.key] = validateValue(variable, raw);
      i += 1;
      continue;
    }

    args.projectName ??= arg;
  }

  return args;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = await parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(await usage());
    return;
  }

  if (args.list) {
    console.log(JSON.stringify(await describeTemplates(), null, 2));
    return;
  }

  if (args.projectName === undefined) {
    console.error(await usage());
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await scaffold(args.projectName, {
      template: args.template,
      values: args.values,
      mcp: args.mcp,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // Verify what we just produced rather than asserting it's fine.
  const check = await checkPath(join(result.target, "src"));

  console.log(`\n  ${result.manifest.title} — ${basename(result.target)}\n`);
  console.log(`  ${result.target}\n`);

  console.log("  Wired up:");
  console.log("    src/                        the contract, checked below");
  console.log("    programmable-launch.config.json");
  console.log("    package.json                depends on @programmable-devkit/sdk");
  if (args.mcp) {
    console.log("    .mcp.json                   Programmable tools for your agent");
  }
  console.log("    AGENTS.md                   constraints your assistant reads");
  console.log("    scripts/watch-launch.mjs    wait for `authorized`, get the sign URL");
  console.log("    scripts/capabilities.mjs    read the live profileDigest");
  console.log("");

  if (check.ok) {
    console.log(
      `  Guardrail check: PASS (${check.filesChecked.length} file(s), ` +
        `${check.warnings} warning(s))\n`,
    );
  } else {
    console.log(
      `  Guardrail check: ${check.blocks} hard block(s) in generated source.\n` +
        "  This is a bug in the template — please report it.\n",
    );
    process.exitCode = 1;
  }

  if (result.unresolved.length > 0) {
    console.log("  Still TODO in programmable-launch.config.json:");
    for (const variable of result.unresolved) {
      console.log(`    ${variable.key.padEnd(16)} ${variable.prompt}`);
    }
    console.log(
      `\n    Pass them at scaffold time next time, e.g. ` +
        `${result.unresolved.map((v) => `${v.flag} <value>`).join(" ")}\n`,
    );
  }

  console.log("  Next:");
  console.log(`    cd ${args.projectName}`);
  console.log("    npm install");
  console.log("    forge install uniswap/v4-core && forge install foundry-rs/forge-std");
  console.log("    cp .env.example .env    # add your API key");
  console.log("    npm run check\n");

  if (result.manifest.notes !== undefined) {
    console.log(`  Note: ${result.manifest.notes}\n`);
  }
}

export {
  scaffold,
  listTemplates,
  describeTemplates,
  readTemplateManifest,
  DEFAULT_TEMPLATE,
} from "./scaffold.js";

/**
 * Only run when this file *is* the entry point.
 *
 * Comparing resolved real paths, not basenames: `programmable-devkit` also ships a
 * `cli.js`, so a basename match made importing this module silently execute it — the
 * dispatcher ran both CLIs and printed everything twice.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(realpathSync(entry));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
