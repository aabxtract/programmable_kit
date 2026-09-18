/**
 * Project scaffolding.
 *
 * The output is deliberately more than a contract: it is a project an agent can work in
 * immediately. That means the SDK is a *dependency* (not copied source), the MCP server
 * is wired through `.mcp.json`, and AGENTS.md sits at the repo root where assistants
 * look for it.
 */

import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_SOLC } from "./checker/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = resolve(here, "templates");

export const DEFAULT_TEMPLATE = "buyback-hook";

/** Version range the scaffolded project depends on. */
const SDK_RANGE = "^0.1.0";

/**
 * v4-core tag the templates are verified against.
 *
 * Pinned deliberately: the v4 types moved between releases (`SwapParams` and
 * `ModifyLiquidityParams` are nested under `IPoolManager` at this tag and relocated in
 * later ones), so an unpinned `forge install` would break the templates on a future
 * release. Both templates compile against this tag with solc 0.8.26.
 */
const V4_CORE_TAG = "v4.0.0";
const FORGE_STD_TAG = "v1.9.4";

export interface TemplateVariable {
  key: string;
  flag: string;
  prompt: string;
  example?: string;
  default?: string;
  type?: "string" | "integer" | "address";
  min?: number;
  max?: number;
  appliesTo?: string;
}

export interface TemplateManifest {
  name: string;
  title: string;
  description: string;
  contract: string;
  variables: TemplateVariable[];
  claims: string[];
  notes?: string;
}

export interface ScaffoldOptions {
  template?: string;
  /** Values for the template's variables, keyed by `key`. */
  values?: Record<string, string>;
  /** Write `.mcp.json` so the project's agent gets the Programmable tools. Default true. */
  mcp?: boolean;
}

export interface ScaffoldResult {
  target: string;
  manifest: TemplateManifest;
  /** Variables the user did not supply; still `TODO` in the config. */
  unresolved: TemplateVariable[];
}

export async function listTemplates(): Promise<string[]> {
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function readTemplateManifest(template: string): Promise<TemplateManifest> {
  const path = join(TEMPLATES_DIR, template, "template.json");
  return JSON.parse(await readFile(path, "utf8")) as TemplateManifest;
}

/** Load every template's manifest, for `--list` and for agent-facing help. */
export async function describeTemplates(): Promise<TemplateManifest[]> {
  const names = await listTemplates();
  return Promise.all(names.map((name) => readTemplateManifest(name)));
}

/** Validate one supplied value against its declared type and bounds. */
export function validateValue(variable: TemplateVariable, raw: string): string {
  const value = raw.trim();

  if (variable.type === "integer") {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${variable.flag} must be a whole number, got "${raw}".`);
    }
    const n = Number(value);
    if (variable.min !== undefined && n < variable.min) {
      throw new Error(`${variable.flag} must be >= ${variable.min}, got ${n}.`);
    }
    if (variable.max !== undefined && n > variable.max) {
      throw new Error(`${variable.flag} must be <= ${variable.max}, got ${n}.`);
    }
    return value;
  }

  if (variable.type === "address") {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
      throw new Error(
        `${variable.flag} must be a 20-byte hex address (0x + 40 hex chars), got "${raw}".`,
      );
    }
    return value;
  }

  if (value === "") throw new Error(`${variable.flag} cannot be empty.`);
  return value;
}

/**
 * Substitute `{{KEY}}` placeholders.
 *
 * Anything unsupplied becomes `TODO`, so the config stays obviously incomplete rather
 * than quietly shipping a placeholder that looks like a real value.
 */
function substitute(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) return "TODO";
    return value;
  });
}

/**
 * Numeric placeholders sit unquoted in JSON (`"bps": {{BPS}}`), so an unresolved one
 * would produce `"bps": TODO` — invalid JSON. Quote those specifically.
 */
function repairUnquotedTodo(json: string): string {
  return json.replace(/:\s*TODO\s*(,|\n|\})/g, (_m, tail: string) => `: "TODO"${tail}`);
}

function projectPackageJson(projectName: string, contract: string): string {
  return `${JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      type: "module",
      description: `Uniswap v4 hook (${contract}) for Programmable Market on Robinhood Chain`,
      engines: { node: ">=20.6" },
      scripts: {
        check: "programmable-check ./src/",
        setup: `forge install uniswap/v4-core@${V4_CORE_TAG} && forge install foundry-rs/forge-std@${FORGE_STD_TAG}`,
        build: "forge build",
        test: "forge test",
        watch: "node --env-file=.env scripts/watch-launch.mjs",
        capabilities: "node --env-file=.env scripts/capabilities.mjs",
      },
      dependencies: {
        "@programmable-devkit/sdk": SDK_RANGE,
      },
      devDependencies: {
        "create-programmable-hook": SDK_RANGE,
      },
    },
    null,
    2,
  )}\n`;
}

/** Project-scoped MCP config, picked up by Claude Code, Cursor, and Windsurf. */
function mcpConfig(): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        programmable: {
          command: "npx",
          args: ["-y", "@programmable-devkit/mcp-server"],
          env: {
            // Expanded from your environment at launch — never inline the key here.
            // This file is commonly committed.
            PROGRAMMABLE_API_KEY: "${PROGRAMMABLE_API_KEY}",
            PROGRAMMABLE_CHAIN_ID: "4663",
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function watchScript(): string {
  return `#!/usr/bin/env node
/**
 * Watch a custom launch until it is ready for wallet signing.
 *
 *   npm run watch -- <launchId>
 *
 * With no launch id, lists your recent launches so you can pick one.
 */

import {
  createClient,
  ProgrammableActionRequiredError,
  ProgrammableLaunchFailedError,
} from "@programmable-devkit/sdk";

const client = createClient();
const launchId = process.argv[2];

if (!client.hasApiKey) {
  console.error("Set PROGRAMMABLE_API_KEY in .env first.");
  process.exit(1);
}

if (!launchId) {
  const page = await client.launches.listCustomLaunches({ limit: 10 });
  if (page.launches.length === 0) {
    console.log("No custom launches on this API key yet.");
    process.exit(0);
  }
  console.log("Your recent launches:\\n");
  for (const l of page.launches) {
    console.log(\`  \${l.launchId}  \${l.status.padEnd(26)} \${l.failure?.code ?? ""}\`);
  }
  console.log("\\nRe-run with:  npm run watch -- <launchId>");
  process.exit(0);
}

try {
  const result = await client.launches.watchUntil(launchId, "authorized", {
    onPoll: (status, n) => console.log(\`  poll \${n}: \${status.status}\`),
  });
  console.log("\\nAuthorized. Sign here:\\n  " + result.walletHandoffUrl);
} catch (error) {
  if (error instanceof ProgrammableActionRequiredError) {
    console.error("\\nWaiting on you, not the server:");
    console.error("  " + (error.failure?.code ?? error.state));
    console.error("  " + (error.failure?.message ?? ""));
    process.exit(1);
  }
  if (error instanceof ProgrammableLaunchFailedError) {
    console.error("\\nLaunch failed: " + (error.failure?.code ?? error.state));
    console.error("  retryable: " + String(error.failure?.retryable));
    process.exit(1);
  }
  throw error;
}
`;
}

function capabilitiesScript(): string {
  return `#!/usr/bin/env node
/**
 * Print the live admission profile, including the profileDigest your config must bind.
 *
 *   npm run capabilities
 *
 * A stale digest fails submission with PLAN_MANIFEST_MISMATCH, so read it fresh rather
 * than copying one from a guide.
 */

import { createClient } from "@programmable-devkit/sdk";

const client = createClient();

if (!client.hasApiKey) {
  console.error("Set PROGRAMMABLE_API_KEY in .env first.");
  process.exit(1);
}

const capabilities = await client.http.request({
  origin: "customLaunch",
  path: \`/v4/chains/\${client.chainId}/capabilities\`,
}, { auth: true });

console.log("compiler      ", capabilities.toolchains?.[0]?.version ?? "?");
console.log("profileDigest ", capabilities.profile?.profileDigest ?? "?");
console.log("profileVersion", capabilities.profile?.profileVersion ?? "?");
console.log("\\nPaste profileDigest into programmable-launch.config.json -> profile.profileDigest");
`;
}

function envExample(): string {
  return `# Copy to .env and fill in. .env is gitignored — keep it that way.
# Get a key at https://programmable.market/developers/api-keys
PROGRAMMABLE_API_KEY=
`;
}

function gitignore(): string {
  return `# Secrets — never commit
.env
.env.*
!.env.example

# The submission request is immutable and identifying; keep it local
launch.json

# Foundry
out/
cache/
broadcast/
lib/

node_modules/
`;
}

function foundryToml(): string {
  const version = REQUIRED_SOLC.split("+")[0];
  return `[profile.default]
src = "src"
out = "out"
libs = ["lib"]

# Pinned to the platform toolchain (${REQUIRED_SOLC}).
# A different compiler produces a different runtime hash and fails the
# runtime_binding invariant at admission.
solc_version = "${version}"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200

[profile.default.fmt]
line_length = 120
`;
}

function remappings(): string {
  return `v4-core/=lib/v4-core/src/
forge-std/=lib/forge-std/src/
`;
}

function preCommitHook(): string {
  return `#!/bin/sh
#
# Key leak guard. Install with:  git config core.hooksPath .git-hooks
# Bypass with: git commit --no-verify

set -e
FOUND=0
STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$STAGED" ] && exit 0

for file in $STAGED; do
  case "$file" in
    *.env.example|*.env.sample) continue ;;
    .env|*/.env|*.env|.env.*|*/.env.*)
      printf 'BLOCKED: %s is an env file and must not be committed.\\n' "$file" >&2
      FOUND=1
      ;;
  esac
done

SECRETS=$(git diff --cached -U0 -- $STAGED 2>/dev/null \\
  | grep -E '^\\+' \\
  | grep -E '(-----BEGIN [A-Z ]*PRIVATE KEY-----)|(\\b0x[a-fA-F0-9]{64}\\b)|(\\bpm_live_[A-Za-z0-9_-]{16,})' \\
  || true)

if [ -n "$SECRETS" ]; then
  printf 'BLOCKED: a private key or API key is staged.\\n%s\\n' "$SECRETS" >&2
  printf '  A 0x-prefixed 64-hex string is a wallet private key. Do not commit it.\\n' >&2
  FOUND=1
fi

[ "$FOUND" -ne 0 ] && { printf '\\nCommit aborted.\\n' >&2; exit 1; }
exit 0
`;
}

function readme(
  projectName: string,
  manifest: TemplateManifest,
  unresolved: TemplateVariable[],
  mcp: boolean,
): string {
  const todo =
    unresolved.length === 0
      ? "All template fields were filled at scaffold time."
      : `Still \`TODO\` in \`programmable-launch.config.json\`:\n\n${unresolved
          .map((v) => `- \`${v.key}\` — ${v.prompt}`)
          .join("\n")}`;

  return `# ${projectName}

${manifest.description} A Uniswap v4 hook for
[Programmable Market](https://programmable.market) on Robinhood Chain (chainId 4663),
scaffolded from \`${manifest.name}\`.

## Setup

\`\`\`bash
npm install
npm run setup                 # forge install, pinned to verified tags
git config core.hooksPath .git-hooks
cp .env.example .env          # then add your API key
forge build
\`\`\`

> The v4-core tag is pinned to \`${V4_CORE_TAG}\`. The v4 types moved between releases —
> \`SwapParams\` is nested under \`IPoolManager\` at this tag and relocated later — so an
> unpinned install will break this contract on a future release. Both templates are
> verified to compile against this tag with solc \`${REQUIRED_SOLC.split("+")[0]}\`.

## Before you submit

\`\`\`bash
npm run check                 # programmable-check ./src/
\`\`\`

A custom launch request is **immutable** — a rejected submission burns the attempt.
The checker runs the platform's admission invariants against your source first.
Exit 0 means nothing would hard-block.

Warnings don't block admission, but each is a **disclosure obligation** — declare it
under \`disclosures\` in the config rather than letting review find it.

## Config

${todo}

Bind the live profile digest before packing — a stale one fails with
\`PLAN_MANIFEST_MISMATCH\`:

\`\`\`bash
npm run capabilities
\`\`\`

${manifest.notes ? `> **Note.** ${manifest.notes}\n` : ""}
## Watching a launch

\`\`\`bash
npm run watch                 # lists your launches
npm run watch -- <launchId>   # waits for \`authorized\`, prints the wallet handoff URL
\`\`\`

\`action_required\` means the launch is waiting on **you** — read \`failure.code\`.
Only \`failed\` is terminal.

## Working with an AI agent
${
  mcp
    ? `
\`.mcp.json\` is already wired. Claude Code, Cursor, and Windsurf will pick up the
Programmable MCP tools in this project automatically — launches, modules, verification,
submission gate, and your own launch statuses.

Export your key first so the config can expand it:

\`\`\`bash
export PROGRAMMABLE_API_KEY=pm_live_...
\`\`\`
`
    : `
Run \`npx create-programmable-hook --help\` and re-scaffold with MCP enabled, or add
\`.mcp.json\` yourself pointing at \`@programmable-devkit/mcp-server\`.
`
}
\`AGENTS.md\` gives your assistant the exact constraints: the pinned compiler, all 14
permission bits and which four are flags, the callback return shapes, and the config
fields that fail silently. Keep it at the repo root.

## The three rules that break most hooks

1. **Pin the compiler.** \`pragma solidity ${REQUIRED_SOLC.split("+")[0]};\` exactly, no caret.
2. **Never hardcode the PoolManager.** Inject it via the constructor, hold it \`immutable\`.
3. **Permissions must match implementations** — and the mined address bits. Three-way agreement.
`;
}

export async function scaffold(
  projectName: string,
  options: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
  const template = options.template ?? DEFAULT_TEMPLATE;
  const withMcp = options.mcp ?? true;
  const values = options.values ?? {};

  const templates = await listTemplates();
  if (!templates.includes(template)) {
    throw new Error(`Unknown template "${template}". Available: ${templates.join(", ")}`);
  }

  const target = resolve(process.cwd(), projectName);
  if (existsSync(target)) {
    throw new Error(`${target} already exists. Pick another name or remove it first.`);
  }

  const templateDir = join(TEMPLATES_DIR, template);
  const manifest = await readTemplateManifest(template);

  // Apply declared defaults for anything the caller left out.
  const resolved: Record<string, string> = { ...values };
  for (const variable of manifest.variables) {
    if (resolved[variable.key] === undefined && variable.default !== undefined) {
      resolved[variable.key] = variable.default;
    }
  }
  const unresolved = manifest.variables.filter((v) => resolved[v.key] === undefined);

  await mkdir(target, { recursive: true });
  await cp(templateDir, target, { recursive: true });

  // template.json is scaffolder metadata, not project content.
  await rmIfPresent(join(target, "template.json"));

  // Substitute placeholders in the launch config.
  const configPath = join(target, "programmable-launch.config.json");
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf8");
    await writeFile(configPath, repairUnquotedTodo(substitute(raw, resolved)));
  }

  await mkdir(join(target, ".git-hooks"), { recursive: true });
  await mkdir(join(target, "scripts"), { recursive: true });

  await writeFile(join(target, ".git-hooks", "pre-commit"), preCommitHook(), {
    mode: 0o755,
  });
  await writeFile(join(target, ".gitignore"), gitignore());
  await writeFile(join(target, ".env.example"), envExample());
  await writeFile(join(target, "foundry.toml"), foundryToml());
  await writeFile(join(target, "remappings.txt"), remappings());
  await writeFile(
    join(target, "package.json"),
    projectPackageJson(basename(projectName), manifest.contract),
  );
  await writeFile(join(target, "scripts", "watch-launch.mjs"), watchScript());
  await writeFile(join(target, "scripts", "capabilities.mjs"), capabilitiesScript());
  await writeFile(
    join(target, "README.md"),
    readme(basename(projectName), manifest, unresolved, withMcp),
  );

  if (withMcp) {
    await writeFile(join(target, ".mcp.json"), mcpConfig());
  }

  const agentsSource = resolve(here, "../AGENTS/AGENTS.md");
  if (existsSync(agentsSource)) {
    await writeFile(join(target, "AGENTS.md"), await readFile(agentsSource, "utf8"));
  }

  return { target, manifest, unresolved };
}

async function rmIfPresent(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { force: true });
}
