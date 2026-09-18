/**
 * create-programmable-hook — programmatic API.
 *
 * The CLIs are thin wrappers over these, so the scaffolder and checker can be driven
 * from CI, an editor extension, or an agent without shelling out.
 */

export {
  scaffold,
  listTemplates,
  describeTemplates,
  readTemplateManifest,
  validateValue,
  DEFAULT_TEMPLATE,
} from "./scaffold.js";
export type {
  ScaffoldOptions,
  ScaffoldResult,
  TemplateManifest,
  TemplateVariable,
} from "./scaffold.js";
export { checkPath, checkSource } from "./checker/index.js";
export { RULES, HARD_BLOCK_COUNT } from "./checker/rules.js";
export type { CheckResult } from "./checker/index.js";
export type { Finding, Rule, Severity } from "./checker/rules.js";
export * from "./checker/constants.js";
