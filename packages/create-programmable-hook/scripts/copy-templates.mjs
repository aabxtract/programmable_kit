#!/usr/bin/env node
/**
 * Copy non-TypeScript template assets into dist/.
 *
 * `tsc` only emits .ts files, so the .sol and .json templates would be missing from a
 * published package without this. Keeping templates under src/ (rather than shipping
 * src/ itself) means dist/ stays self-contained and `files` stays a single entry.
 */

import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(packageRoot, "src/templates");
const to = resolve(packageRoot, "dist/templates");

await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });

console.log(`copied templates -> ${to}`);
