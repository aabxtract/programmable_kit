/**
 * programmable-devkit — meta-package.
 *
 * Re-exports the SDK and the hook toolkit so a single dependency gives you everything.
 * The CLI (`programmable`) is the primary interface; this exists for programmatic use.
 */

export * from "@programmable-devkit/sdk";
export {
  scaffold,
  checkPath,
  checkSource,
  describeTemplates,
  listTemplates,
  readTemplateManifest,
  validateValue,
  RULES,
  HARD_BLOCK_COUNT,
  REQUIRED_SOLC,
  HOOK_PERMISSION_BITS,
  CALLBACK_PERMISSIONS,
  RETURN_DELTA_DEPENDENCIES,
  INVARIANTS,
} from "create-programmable-hook";
export type {
  CheckResult,
  Finding,
  Rule,
  Severity,
  ScaffoldOptions,
  ScaffoldResult,
  TemplateManifest,
  TemplateVariable,
} from "create-programmable-hook";
