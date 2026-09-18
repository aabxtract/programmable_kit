#!/usr/bin/env node
/**
 * create-programmable-hook regression check.
 *
 * Two things this proves, neither of which the type checker can:
 *
 *   1. Every template scaffolds and passes its own guardrail check. A template that
 *      drifts into a hard-block violation would otherwise ship, and the developer would
 *      discover it by burning an immutable submission.
 *   2. The checker actually catches violations. A checker that only ever passes is
 *      worse than none, because it is trusted. The fixture deliberately breaks all
 *      seven hard blocks and the run asserts each one fires.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  checkPath,
  scaffold,
  listTemplates,
  describeTemplates,
  validateValue,
} from "create-programmable-hook";

const FIXTURE = resolve(
  "packages/create-programmable-hook/test/fixtures/BadHook.sol",
);

/** Every hard-block rule must be provably reachable. */
const EXPECTED_BLOCKS = [
  "HC-001",
  "HC-002",
  "HC-003",
  "HC-004",
  "HC-005",
  "HC-006",
  "HC-007",
];

/** Comments mentioning forbidden keywords must not trip the scanner. */
const COMMENT_SAFE_LINES = [4, 5];

async function main(): Promise<void> {
  console.log("\ncreate-programmable-hook — regression check\n");

  let failed = 0;
  const workdir = await mkdtemp(join(tmpdir(), "phook-"));
  const previousCwd = process.cwd();

  try {
    // 1. Templates scaffold clean.
    const templates = await listTemplates();
    console.log(`  ${templates.length} template(s): ${templates.join(", ")}\n`);

    process.chdir(workdir);

    /** Files a scaffolded project must always contain to be agent-ready. */
    const REQUIRED = [
      "package.json",
      ".mcp.json",
      "AGENTS.md",
      ".gitignore",
      ".env.example",
      "foundry.toml",
      "remappings.txt",
      "scripts/watch-launch.mjs",
      "scripts/capabilities.mjs",
      "programmable-launch.config.json",
    ];

    for (const template of templates) {
      const { target } = await scaffold(`proj-${template}`, { template });
      const result = await checkPath(join(target, "src"));

      const missing = REQUIRED.filter((f) => !existsSync(join(target, f)));
      if (missing.length > 0) {
        console.log(`  FAIL scaffold ${template.padEnd(18)} missing: ${missing.join(", ")}`);
        failed += 1;
      }

      // The config must parse even with placeholders unresolved — numeric placeholders
      // sit unquoted in the template, so a naive substitution yields invalid JSON.
      const configText = await readFile(
        join(target, "programmable-launch.config.json"),
        "utf8",
      );
      try {
        JSON.parse(configText);
      } catch (error) {
        console.log(
          `  FAIL config json  ${template.padEnd(18)} ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        failed += 1;
      }

      if (configText.includes("{{")) {
        console.log(`  FAIL config json  ${template.padEnd(18)} unsubstituted placeholder`);
        failed += 1;
      }

      // Generated scripts must not call process.exit() after a fetch: on Node 24 for
      // Windows that aborts with a libuv assertion instead of exiting. Setting
      // process.exitCode and letting Node drain is the portable form.
      for (const script of ["scripts/watch-launch.mjs", "scripts/capabilities.mjs"]) {
        // Strip comments first — these scripts *document* why they avoid
        // process.exit(), and matching that prose would fail a correct file.
        const body = (await readFile(join(target, script), "utf8"))
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (/process\.exit\s*\(/.test(body)) {
          console.log(`  FAIL ${script.padEnd(30)} calls process.exit() — use exitCode`);
          failed += 1;
        }
      }

      if (result.ok) {
        console.log(
          `  PASS scaffold ${template.padEnd(18)} clean (${result.warnings} warning(s))`,
        );
      } else {
        console.log(
          `  FAIL scaffold ${template.padEnd(18)} ${result.blocks} hard block(s)`,
        );
        for (const f of result.findings.filter((x) => x.severity === "block")) {
          console.log(`         ${f.id} ${f.file}:${f.line} ${f.title}`);
        }
        failed += 1;
      }
    }

    process.chdir(previousCwd);
    console.log("");

    // 2. The checker catches a deliberately bad hook.
    const bad = await checkPath(FIXTURE);
    const firedIds = new Set(
      bad.findings.filter((f) => f.severity === "block").map((f) => f.id),
    );

    const missing = EXPECTED_BLOCKS.filter((id) => !firedIds.has(id));
    if (missing.length === 0) {
      console.log(
        `  PASS fixture detection      all ${EXPECTED_BLOCKS.length} hard blocks fired`,
      );
    } else {
      console.log(`  FAIL fixture detection      never fired: ${missing.join(", ")}`);
      failed += 1;
    }

    // 3. Comments must not produce findings.
    const fromComments = bad.findings.filter((f) => COMMENT_SAFE_LINES.includes(f.line));
    if (fromComments.length === 0) {
      console.log("  PASS comment stripping      no findings from commented keywords");
    } else {
      console.log(
        `  FAIL comment stripping      ${fromComments.length} false positive(s): ` +
          fromComments.map((f) => `${f.id}@${f.line}`).join(", "),
      );
      failed += 1;
    }

    // 3b. Supplied values must actually land in the config.
    process.chdir(workdir);
    const { target: filled } = await scaffold("proj-filled", {
      template: "creator-fee-hook",
      values: { CREATOR_FEE: "3000", TOKEN_NAME: "Creator Coin", TOKEN_SYMBOL: "CRTR" },
    });
    process.chdir(previousCwd);

    const filledConfig = JSON.parse(
      await readFile(join(filled, "programmable-launch.config.json"), "utf8"),
    );
    const fee = filledConfig.hook?.constructorArgs?.creatorFee;
    if (fee === 3000 && filledConfig.token?.symbol === "CRTR") {
      console.log("  PASS value substitution     --fee 3000 landed as a JSON number");
    } else {
      console.log(`  FAIL value substitution     creatorFee=${JSON.stringify(fee)}`);
      failed += 1;
    }

    // 3c. Bad input must be rejected before it reaches a config file.
    const manifests = await describeTemplates();
    const feeVar = manifests
      .flatMap((m) => m.variables)
      .find((v) => v.flag === "--fee");
    let rejected = false;
    try {
      if (feeVar !== undefined) validateValue(feeVar, "0.3%");
    } catch {
      rejected = true;
    }
    console.log(
      rejected
        ? "  PASS input validation       --fee 0.3% rejected (pips must be integer)"
        : "  FAIL input validation       --fee 0.3% was accepted",
    );
    if (!rejected) failed += 1;

    // 4. Warnings must not affect the pass/fail verdict.
    if (!bad.ok && bad.warnings > 0) {
      console.log(`  PASS severity split         ${bad.blocks} blocks, ${bad.warnings} warnings`);
    } else {
      console.log("  FAIL severity split         expected both blocks and warnings");
      failed += 1;
    }
  } finally {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\nhook toolkit OK\n" : `\n${failed} check(s) failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
