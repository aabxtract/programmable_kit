/**
 * The rule set.
 *
 * Every hard-block rule cites the live manifest invariant it enforces, so a finding can
 * be traced to the platform's own words rather than to this tool's opinion.
 */

import {
  CALLBACK_PERMISSIONS,
  CALLBACK_RETURN_SHAPE,
  EFFECTFUL_CALLBACKS,
  HOOK_PERMISSION_BITS,
  INVARIANTS,
  REQUIRED_PRAGMA,
  RESERVED_ACTION_PREFIXES,
  RETURN_DELTA_DEPENDENCIES,
  type CallbackName,
} from "./constants.js";
import { findFunctions, lineAt, readDeclaredPermissions, type StrippedSource } from "./parse.js";

export type Severity = "block" | "warn";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** The manifest invariant this enforces, for hard blocks. */
  invariant?: string;
  file: string;
  line: number;
}

export interface Rule {
  id: string;
  severity: Severity;
  title: string;
  run: (source: StrippedSource, file: string) => Finding[];
}

function finding(
  rule: Pick<Rule, "id" | "severity" | "title">,
  file: string,
  line: number,
  detail: string,
  invariant?: string,
): Finding {
  return {
    id: rule.id,
    severity: rule.severity,
    title: rule.title,
    detail,
    file,
    line,
    ...(invariant !== undefined ? { invariant } : {}),
  };
}

/**
 * Is this body just a revert stub?
 *
 * The v4 `IHooks` interface forces a hook to declare all ten callbacks even when it
 * implements one, so the idiomatic pattern (and what `BaseHook` does) is to stub the
 * rest with `revert HookNotImplemented();`. A stub is not an implementation: it needs
 * no PoolManager guard, and it must not count as "implemented" when reconciling against
 * the permission bits. Treating stubs as real code would flag every correct hook.
 */
function isStub(body: string): boolean {
  const inner = body.replace(/^\s*\{/, "").replace(/\}\s*$/, "").trim();
  if (inner === "") return true;

  const statements = inner
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  return statements.every((s) => /^revert\b/.test(s) || /^return\s*\(?\s*\)?$/.test(s));
}

/** Does this function body contain a PoolManager caller check? */
function hasPoolManagerGuard(body: string): boolean {
  // Accept a modifier-based guard, an explicit require/revert, or a bare comparison.
  if (/\bonly(Pool|)Manager\b/i.test(body)) return true;

  const mentionsSender = /\bmsg\.sender\b/.test(body);
  const mentionsManager = /\b(poolManager|POOL_MANAGER|manager|_poolManager)\b/.test(body);

  return mentionsSender && mentionsManager;
}

/** Is the guard applied via a modifier in the function signature rather than the body? */
function hasGuardModifier(attributes: string): boolean {
  return /\bonly[A-Za-z_$][\w$]*\b/.test(attributes);
}

const HC001: Rule = {
  id: "HC-001",
  severity: "block",
  title: "CALLCODE usage",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];
    const pattern = /\bcallcode\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      findings.push(
        finding(
          HC001,
          file,
          lineAt(original, match.index),
          "`callcode` is a deprecated, unsafe delegation opcode. The platform rejects " +
            "any source containing it. Use a normal external call.",
          INVARIANTS.source_binding,
        ),
      );
    }
    return findings;
  },
};

const HC002: Rule = {
  id: "HC-002",
  severity: "block",
  title: "SELFDESTRUCT in source",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];
    const pattern = /\b(selfdestruct|suicide)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      findings.push(
        finding(
          HC002,
          file,
          lineAt(original, match.index),
          `\`${match[1]}\` makes the deployed runtime destructible, which breaks the ` +
            "immutability the platform binds at admission.",
          INVARIANTS.runtime_binding,
        ),
      );
    }
    return findings;
  },
};

const HC003: Rule = {
  id: "HC-003",
  severity: "block",
  title: "Missing callback authorization",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];

    for (const fn of findFunctions(code)) {
      if (!EFFECTFUL_CALLBACKS.includes(fn.name as CallbackName)) continue;
      if (fn.body === "") continue; // interface or abstract declaration
      if (isStub(fn.body)) continue; // disabled callback, carries no effect
      if (hasGuardModifier(fn.attributes)) continue;
      if (hasPoolManagerGuard(fn.body)) continue;

      findings.push(
        finding(
          HC003,
          file,
          lineAt(original, fn.start),
          `\`${fn.name}\` does not reject callers other than the PoolManager. Add ` +
            "`if (msg.sender != address(poolManager)) revert NotPoolManager();` as the " +
            "first statement, or apply an `onlyPoolManager` modifier.",
          INVARIANTS.callback_authority,
        ),
      );
    }

    return findings;
  },
};

const HC004: Rule = {
  id: "HC-004",
  severity: "block",
  title: "Hardcoded PoolManager address",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];

    // A 20-byte literal on a line that also names the pool manager is the signature of
    // a baked-in address. Constructor injection is the only accepted binding.
    const pattern =
      /\b(?:poolManager|POOL_MANAGER|_poolManager|manager)\b[^;\n]*?(0x[a-fA-F0-9]{40})\b/g;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      findings.push(
        finding(
          HC004,
          file,
          lineAt(original, match.index),
          `PoolManager appears to be hardcoded to \`${match[1]}\`. The platform binds ` +
            "the PoolManager itself; inject it through the constructor and store it as " +
            "`immutable` instead.",
          INVARIANTS.source_binding,
        ),
      );
    }

    return findings;
  },
};

const HC005: Rule = {
  id: "HC-005",
  severity: "block",
  title: "Permission / implementation mismatch",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];
    const declared = readDeclaredPermissions(code);
    if (declared.size === 0) return findings;

    const permissionsFn = findFunctions(code).find(
      (fn) => fn.name === "getHookPermissions",
    );
    const line = permissionsFn ? lineAt(original, permissionsFn.start) : 1;
    const implemented = new Set(
      findFunctions(code)
        .filter((fn) => fn.body !== "" && !isStub(fn.body))
        .map((fn) => fn.name),
    );

    // Enabled callback bit with no matching function.
    for (const name of CALLBACK_PERMISSIONS) {
      if (declared.get(name) === true && !implemented.has(name)) {
        findings.push(
          finding(
            HC005,
            file,
            line,
            `\`${name}\` is enabled (bit ${HOOK_PERMISSION_BITS[name]}) but no ` +
              `\`${name}()\` is implemented. The address permission bits and the ` +
              "declaration must agree.",
            INVARIANTS.hook_permissions,
          ),
        );
      }
    }

    // Implemented callback that the declaration leaves off — the inverse mismatch, and
    // the one people miss: the function exists, so it looks wired up, but the address
    // bit is never set and the PoolManager will never call it.
    for (const name of CALLBACK_PERMISSIONS) {
      if (implemented.has(name) && declared.get(name) !== true) {
        findings.push(
          finding(
            HC005,
            file,
            line,
            `\`${name}()\` is implemented but its permission bit is not enabled. The ` +
              "PoolManager will never call it. Either enable the bit or remove the " +
              "function.",
            INVARIANTS.hook_permissions,
          ),
        );
      }
    }

    // Return-delta flag without its parent callback.
    for (const [flag, parent] of Object.entries(RETURN_DELTA_DEPENDENCIES)) {
      if (declared.get(flag) === true && declared.get(parent) !== true) {
        findings.push(
          finding(
            HC005,
            file,
            line,
            `\`${flag}\` is enabled but its dependency \`${parent}\` is not. ` +
              "Return-delta bits require their parent callback.",
            INVARIANTS.hook_permissions,
          ),
        );
      }
    }

    return findings;
  },
};

const HC006: Rule = {
  id: "HC-006",
  severity: "block",
  title: "Callback return shape mismatch",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];

    for (const fn of findFunctions(code)) {
      const name = fn.name as CallbackName;
      const expected = CALLBACK_RETURN_SHAPE[name];
      if (expected === undefined || fn.body === "" || isStub(fn.body)) continue;

      const actual = fn.returns
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0] ?? "")
        .filter((part) => part !== "");

      if (actual.length !== expected.length) {
        findings.push(
          finding(
            HC006,
            file,
            lineAt(original, fn.start),
            `\`${name}\` returns ${actual.length} value(s) but the v4 interface ` +
              `requires ${expected.length}: (${expected.join(", ")}). A wrong return ` +
              "shape makes the callback undecodable by the PoolManager.",
            INVARIANTS.callback_abi,
          ),
        );
      }
    }

    return findings;
  },
};

const HC007: Rule = {
  id: "HC-007",
  severity: "block",
  title: "Reserved platform action id",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];

    for (const prefix of RESERVED_ACTION_PREFIXES) {
      const pattern = new RegExp(`["']${prefix.replace(":", ":")}`, "g");
      let match: RegExpExecArray | null;
      // Scan the original here: reserved ids live inside string literals, which the
      // stripper blanks out by design.
      while ((match = pattern.exec(original)) !== null) {
        findings.push(
          finding(
            HC007,
            file,
            lineAt(original, match.index),
            `\`${prefix}\` is a reserved action id prefix. The platform owns it and ` +
              "fills the terminal stamp call itself; declaring one is rejected.",
            INVARIANTS.platform_authority,
          ),
        );
      }
    }

    return findings;
  },
};

const W001: Rule = {
  id: "W-001",
  severity: "warn",
  title: "DELEGATECALL usage",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];
    const pattern = /\bdelegatecall\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      findings.push(
        finding(
          W001,
          file,
          lineAt(original, match.index),
          "DELEGATECALL is permitted but requires evidence disclosure at submission. " +
            "Expect additional review.",
        ),
      );
    }
    return findings;
  },
};

const W002: Rule = {
  id: "W-002",
  severity: "warn",
  title: "Compiler version mismatch",
  run: ({ code, original }, file) => {
    const match = /pragma\s+solidity\s+([^;]+);/.exec(code);

    if (match === null) {
      return [
        finding(W002, file, 1, "No `pragma solidity` found. The platform pins " + `${REQUIRED_PRAGMA}.`),
      ];
    }

    const version = (match[1] ?? "").trim();
    if (version === REQUIRED_PRAGMA) return [];

    return [
      finding(
        W002,
        file,
        lineAt(original, match.index),
        `pragma is \`${version}\` but the platform compiles with exactly ` +
          `${REQUIRED_PRAGMA}. Use \`pragma solidity ${REQUIRED_PRAGMA};\` with no ` +
          "caret — a floating pragma changes the runtime hash the platform binds.",
      ),
    ];
  },
};

const W003: Rule = {
  id: "W-003",
  severity: "warn",
  title: "Pause or ownership control",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];
    const pattern = /\b(Ownable|onlyOwner|Pausable|_pause|whenNotPaused|transferOwnership)\b/g;
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      const token = match[1] ?? "";
      if (seen.has(token)) continue;
      seen.add(token);

      findings.push(
        finding(
          W003,
          file,
          lineAt(original, match.index),
          `\`${token}\` gives an operator privileged control. Permitted, but it must be ` +
            "disclosed at submission and will attract review.",
        ),
      );
    }

    return findings;
  },
};

const W004: Rule = {
  id: "W-004",
  severity: "warn",
  title: "Mint capability",
  run: ({ code, original }, file) => {
    const findings: Finding[] = [];

    for (const fn of findFunctions(code)) {
      if (!/^_?mint/i.test(fn.name) || fn.body === "") continue;
      findings.push(
        finding(
          W004,
          file,
          lineAt(original, fn.start),
          `\`${fn.name}\` can increase supply. Permitted, but supply-affecting functions ` +
            "must be disclosed at submission.",
        ),
      );
    }

    return findings;
  },
};

/** Hard blocks first, so the report reads worst-first. */
export const RULES: readonly Rule[] = [
  HC001,
  HC002,
  HC003,
  HC004,
  HC005,
  HC006,
  HC007,
  W001,
  W002,
  W003,
  W004,
];

export const HARD_BLOCK_COUNT = RULES.filter((r) => r.severity === "block").length;
