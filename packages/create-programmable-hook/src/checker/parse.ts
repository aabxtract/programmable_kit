/**
 * Lightweight Solidity source inspection.
 *
 * Deliberately not a full parser. The checks here are about the presence, shape, and
 * guarding of known callbacks — a lexical pass with comments and strings removed is
 * enough, and it can't break on syntax a real parser hasn't been taught yet.
 *
 * Comment stripping is load-bearing: without it, `// never use selfdestruct here` is a
 * hard-block violation, and a checker that cries wolf gets switched off.
 */

export interface StrippedSource {
  /** Source with comments and string literals blanked, positions preserved. */
  code: string;
  /** The original, for reporting context. */
  original: string;
}

/**
 * Blank out comments and string/hex literals, preserving offsets and line breaks so
 * reported line numbers still match the original file.
 */
export function stripNoise(source: string): StrippedSource {
  const out = source.split("");
  let i = 0;
  const n = source.length;

  const blank = (start: number, end: number): void => {
    for (let k = start; k < end && k < n; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const two = source.slice(i, i + 2);

    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    const ch = source[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return { code: out.join(""), original: source };
}

/** 1-indexed line number for a character offset. */
export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

export interface SolFunction {
  name: string;
  /** Offset of the `function` keyword. */
  start: number;
  /** Offset just past the closing brace, or of the `;` for declarations. */
  end: number;
  /** Text between the parentheses. */
  params: string;
  /** Text of the `returns (...)` clause, empty when absent. */
  returns: string;
  /** Body between braces; empty for an abstract/interface declaration. */
  body: string;
  /** Modifiers and visibility between the params and the body. */
  attributes: string;
}

/** Find the matching close brace for the open brace at `open`. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/** Extract every function definition from stripped source. */
export function findFunctions(code: string): SolFunction[] {
  const functions: SolFunction[] = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const name = match[1];
    if (name === undefined) continue;

    const parenOpen = match.index + match[0].length - 1;
    const parenClose = matchParen(code, parenOpen);
    const params = code.slice(parenOpen + 1, parenClose - 1);

    // Everything from the close paren to either the body or the terminating semicolon.
    const braceIndex = code.indexOf("{", parenClose);
    const semiIndex = code.indexOf(";", parenClose);
    const isDeclaration =
      semiIndex !== -1 && (braceIndex === -1 || semiIndex < braceIndex);

    const headerEnd = isDeclaration ? semiIndex : braceIndex;
    const header = code.slice(parenClose, headerEnd === -1 ? code.length : headerEnd);

    const returnsMatch = /\breturns\s*\(([^)]*)\)/.exec(header);
    const end = isDeclaration
      ? semiIndex + 1
      : braceIndex === -1
        ? code.length
        : matchBrace(code, braceIndex);

    functions.push({
      name,
      start: match.index,
      end,
      params,
      returns: returnsMatch?.[1] ?? "",
      body: isDeclaration || braceIndex === -1 ? "" : code.slice(braceIndex, end),
      attributes: header.replace(/\breturns\s*\([^)]*\)/, ""),
    });
  }

  return functions;
}

function matchParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/**
 * Read the boolean fields of a `getHookPermissions()` return literal.
 *
 * Handles both the struct-literal style (`beforeSwap: true`) and plain assignment.
 * Returns only what's explicitly present — an absent key is not the same as `false`,
 * and callers need to tell those apart.
 */
export function readDeclaredPermissions(code: string): Map<string, boolean> {
  const declared = new Map<string, boolean>();

  const fn = findFunctions(code).find((f) => f.name === "getHookPermissions");
  if (fn === undefined || fn.body === "") return declared;

  const pattern = /([A-Za-z_$][\w$]*)\s*:\s*(true|false)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fn.body)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) declared.set(key, value === "true");
  }

  return declared;
}
