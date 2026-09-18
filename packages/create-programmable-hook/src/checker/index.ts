/**
 * Guardrail checker — programmatic API.
 *
 * `checkSource` / `checkPath` are exported so the checker can run inside CI, an editor
 * extension, or an agent loop without shelling out to the CLI.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { stripNoise } from "./parse.js";
import { RULES, type Finding } from "./rules.js";

export interface CheckResult {
  findings: Finding[];
  filesChecked: string[];
  blocks: number;
  warnings: number;
  /** True when nothing would hard-block at submission. */
  ok: boolean;
}

/** Run every rule over one source string. */
export function checkSource(source: string, file = "<source>"): Finding[] {
  const stripped = stripNoise(source);
  const findings: Finding[] = [];

  for (const rule of RULES) {
    try {
      findings.push(...rule.run(stripped, file));
    } catch (error) {
      // A rule that throws must not take the whole run down — report it and continue,
      // otherwise one odd file silently disables every remaining check.
      findings.push({
        id: rule.id,
        severity: "warn",
        title: `${rule.title} (rule error)`,
        detail: `This rule failed to run: ${
          error instanceof Error ? error.message : String(error)
        }. Treat its result as unknown, not as a pass.`,
        file,
        line: 1,
      });
    }
  }

  return findings;
}

/** Recursively collect `.sol` files, skipping dependency and artifact directories. */
async function collectSolidity(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return extname(target) === ".sol" ? [target] : [];

  const skip = new Set(["node_modules", "lib", "out", "cache", "artifacts", ".git"]);
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (extname(entry.name) === ".sol") {
        found.push(join(dir, entry.name));
      }
    }
  };

  await walk(target);
  return found.sort();
}

/** Check a file or directory. */
export async function checkPath(target: string): Promise<CheckResult> {
  const absolute = resolve(target);
  const files = await collectSolidity(absolute);
  const findings: Finding[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    findings.push(...checkSource(source, relative(process.cwd(), file) || file));
  }

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "block" ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  const blocks = findings.filter((f) => f.severity === "block").length;
  const warnings = findings.length - blocks;

  return {
    findings,
    filesChecked: files.map((file) => relative(process.cwd(), file) || file),
    blocks,
    warnings,
    ok: blocks === 0,
  };
}

export { RULES, HARD_BLOCK_COUNT } from "./rules.js";
export type { Finding, Rule, Severity } from "./rules.js";
export * from "./constants.js";
