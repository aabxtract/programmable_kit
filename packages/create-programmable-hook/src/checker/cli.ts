#!/usr/bin/env node
/**
 * `programmable-check` — local guardrail checker.
 *
 * Exit 0 when nothing would hard-block at submission, 1 otherwise, so it drops straight
 * into CI. Warnings never fail the run; they're disclosure obligations, not rejections.
 */

import { checkPath } from "./index.js";
import { HARD_BLOCK_COUNT, RULES } from "./rules.js";
import {
  HOOK_PERMISSION_BITS,
  INVARIANTS,
  MAX_RUNTIME_BYTES,
  REQUIRED_SOLC,
} from "./constants.js";

const USAGE = `programmable-check — check Uniswap v4 hooks against Programmable's admission invariants

Usage:
  programmable-check <file-or-directory> [options]

Options:
  --json            Machine-readable output
  --quiet           Only print findings, no summary
  --show-profile    Print the pinned compiler, permission bits, and invariants
  -h, --help        This message

Exit codes:
  0  no hard-block violations (warnings may still be present)
  1  one or more hard-block violations
`;

function showProfile(): void {
  console.log("\nProgrammable v4 admission profile (robinhood-mainnet)\n");
  console.log(`  compiler       ${REQUIRED_SOLC}`);
  console.log(`  runtime limit  ${MAX_RUNTIME_BYTES} bytes`);
  console.log(`  hard blocks    ${HARD_BLOCK_COUNT}`);
  console.log("\n  Hook permission bits (position in the hook address):");
  for (const [name, bit] of Object.entries(HOOK_PERMISSION_BITS)) {
    console.log(`    ${String(bit).padStart(2)}  ${name}`);
  }
  console.log("\n  Invariants enforced locally:");
  for (const [key, text] of Object.entries(INVARIANTS)) {
    console.log(`    ${key}\n      ${text}`);
  }
  console.log(
    "\n  Source: GET /v4/chains/4663/custom-launch-contract/manifest.json\n",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  if (argv.includes("--show-profile")) {
    showProfile();
    return;
  }

  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  const target = argv.find((arg) => !arg.startsWith("-"));

  if (target === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await checkPath(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not read ${target}: ${message}`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (result.filesChecked.length === 0) {
    console.log(`No .sol files found under ${target}`);
    return;
  }

  if (!quiet) {
    console.log(
      `\nprogrammable-check — ${result.filesChecked.length} file(s), ` +
        `${RULES.length} rules (${HARD_BLOCK_COUNT} hard blocks)\n`,
    );
  }

  for (const f of result.findings) {
    const tag = f.severity === "block" ? "BLOCK" : "warn ";
    console.log(`  ${tag} ${f.id}  ${f.file}:${f.line}  ${f.title}`);
    console.log(`        ${f.detail}`);
    if (f.invariant !== undefined) {
      console.log(`        invariant: "${f.invariant}"`);
    }
    console.log("");
  }

  if (quiet) {
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (result.ok && result.warnings === 0) {
    console.log("  No findings. Nothing here would hard-block at submission.\n");
  } else {
    console.log(
      `  ${result.blocks} hard block(s), ${result.warnings} warning(s)\n`,
    );
  }

  if (result.blocks > 0) {
    console.log(
      "  Hard blocks cause `action_required` at submission — and a custom launch\n" +
        "  request is immutable, so a rejected one burns the attempt. Fix these first.\n",
    );
    process.exitCode = 1;
  } else if (result.warnings > 0) {
    console.log(
      "  Warnings do not block admission, but each is a disclosure obligation.\n" +
        "  Declare them in your submission rather than letting review find them.\n",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
