# create-programmable-hook — Build Guide

CLI scaffolder and local guardrail checker for Uniswap v4 hooks on Programmable Market.
Lives in `packages/create-programmable-hook/` inside the devkit monorepo.

> ✅ **Rules are read from the platform, not invented.**
> The pinned compiler, the 14 permission bits, the reserved action prefixes and the
> invariant texts all come from
> `GET /v4/chains/4663/custom-launch-contract/manifest.json` and
> `GET /v4/chains/4663/capabilities`, verified 2026-09-17.
> Print them any time with `programmable-check --show-profile`.

---

## What this package contains

```
packages/create-programmable-hook/
├── src/
│   ├── index.ts                        ← programmatic API
│   ├── cli.ts                          ← npx create-programmable-hook
│   ├── scaffold.ts                     ← templating, substitution, agent wiring
│   ├── checker/
│   │   ├── cli.ts                      ← npx programmable-check
│   │   ├── index.ts                    ← checkPath() / checkSource()
│   │   ├── rules.ts                    ← the 11 rules
│   │   ├── constants.ts                ← facts read from the live manifest
│   │   └── parse.ts                    ← comment-stripping + function extraction
│   └── templates/
│       ├── buyback-hook/
│       │   ├── template.json           ← declares its own flags + validation
│       │   ├── src/BuybackHook.sol
│       │   └── programmable-launch.config.json
│       └── creator-fee-hook/
│           ├── template.json
│           ├── src/CreatorFeeHook.sol
│           └── programmable-launch.config.json
├── test/fixtures/BadHook.sol           ← breaks all 7 hard blocks, on purpose
├── AGENTS/AGENTS.md                    ← machine-readable guide for AI tools
├── scripts/copy-templates.mjs          ← ships .sol/.json into dist/
└── BUILD_GUIDE.md                      ← this file
```

---

## 1. Install dependencies

From the monorepo root:

```bash
npm install
```

---

## 2. Build

```bash
npm run build:hook          # or: npm run build -w packages/create-programmable-hook
```

`tsc` only emits `.ts`, so the build also runs `scripts/copy-templates.mjs` to copy the
`.sol` and `.json` templates into `dist/`. Without that step a published package would
scaffold empty projects.

---

## 3. Using the CLI scaffolder

```bash
npx create-programmable-hook my-hook                              # buyback-hook
npx create-programmable-hook my-hook --template creator-fee-hook
npx create-programmable-hook --list                               # templates as JSON
npx create-programmable-hook --help
```

Or through the meta-package, which is the same thing with one command to remember:

```bash
npm install -g programmable-devkit
programmable new my-hook --template creator-fee-hook --fee 3000
```

### Template variables

Each template declares its own flags in `template.json`, so the CLI's help and validation
are generated rather than hand-maintained:

| Template | Flags |
|---|---|
| `buyback-hook` | `--name` `--symbol` `--treasury` `--bps` |
| `creator-fee-hook` | `--name` `--symbol` `--fee` |

Values are validated **before** anything is written — `--fee 0.3%` is rejected (pips must
be an integer), `--treasury 0x123` is rejected (not 20 bytes). Whatever you don't supply
stays `TODO` in the config, and the command prints what's left rather than letting a
placeholder pass for a real value.

`--fee` is in pips, hundredths of a bip: `3000` = 0.30%.

### What gets scaffolded

| File | Purpose |
|---|---|
| `src/YourHook.sol` | Contract pinned to `0.8.26`, PoolManager auth on every effectful callback, permissions matched to implementations |
| `programmable-launch.config.json` | Pre-filled config, `TODO` fields marked |
| `foundry.toml` | `solc_version` pinned to the platform toolchain |
| `remappings.txt` | `v4-core/` and `forge-std/` |
| `.git-hooks/pre-commit` | Key leak guard (install with `git config core.hooksPath .git-hooks`) |
| `.gitignore` | Excludes `.env`, `launch.json`, `out/`, `cache/`, `lib/` |
| `.env.example` | `PROGRAMMABLE_API_KEY` placeholder |
| `package.json` | Depends on `@aabxtract/programmable-sdk`; `check` / `watch` / `capabilities` scripts |
| `.mcp.json` | Wires the Programmable MCP tools into the project (skip with `--no-mcp`) |
| `AGENTS.md` | Dropped at the project root so assistants pick it up automatically |
| `scripts/watch-launch.mjs` | Waits for `authorized`, prints the wallet handoff URL |
| `scripts/capabilities.mjs` | Reads the live `profileDigest` your config must bind |
| `README.md` | Submission workflow specific to Programmable |

### Why the SDK is a dependency, not scaffolded source

The project gets `@aabxtract/programmable-sdk` in its `package.json` rather than a copy of
the SDK's files. Copied source goes stale the moment the platform changes an endpoint,
and the developer has no way to pull a fix. As a dependency it updates with
`npm install`.

The same reasoning applies to the MCP server: `.mcp.json` points at
`npx @aabxtract/programmable-mcp-server`, so the agent always runs the current version.
`${PROGRAMMABLE_API_KEY}` is expanded from the environment at launch — the key is never
written into a file that gets committed.

The scaffolder **runs the checker on its own output** and reports the result. A template
that drifts into a violation fails loudly at scaffold time rather than at submission.

Templates import from `v4-core`, so a fresh project needs:

```bash
forge install uniswap/v4-core && forge install foundry-rs/forge-std
```

---

## 4. Using the guardrail checker

```bash
npx programmable-check ./src/MyHook.sol     # one file
npx programmable-check ./src/               # a directory
npx programmable-check ./src/ --json        # machine-readable
npx programmable-check --show-profile       # the pinned rules themselves
```

`node_modules`, `lib`, `out`, `cache` and `artifacts` are skipped automatically.

### The 7 hard blocks

Each cites the manifest invariant it enforces, so a finding traces back to the
platform's own words rather than to this tool's opinion.

| ID | Condition | Invariant enforced |
|----|-----------|--------------------|
| HC-001 | `callcode` anywhere in source | `source_binding` |
| HC-002 | `selfdestruct` / `suicide` anywhere in source | `runtime_binding` |
| HC-003 | Effectful callback with no PoolManager check | `callback_authority` |
| HC-004 | Hardcoded address used as the PoolManager | `source_binding` |
| HC-005 | Permissions and implementations disagree | `hook_permissions` |
| HC-006 | Callback returns the wrong number of values | `callback_abi` |
| HC-007 | Declares a reserved `platform:` action id | `platform_authority` |

> **Note on the count.** An earlier draft of this guide said "7 hard-block conditions"
> but listed five (HC-001…HC-005). Rather than pad the list, HC-006 and HC-007 were
> derived from two live manifest invariants that the original five didn't cover —
> `callback_abi` and `platform_authority`. All seven are grounded; none are invented.

HC-005 is three checks in one, because the mismatch runs both ways and has a third
wrinkle most people hit:

- an enabled bit with no matching function
- a function whose bit is **off** — it looks wired up, but the PoolManager never calls it
- a return-delta flag without its parent callback (`beforeSwapReturnDelta` needs
  `beforeSwap`)

The bottom four permission bits are **flags, not callbacks**. There is no
`beforeSwapReturnDelta()` function, and a checker that expects one flags every correct
hook.

### Soft warnings

| ID | Condition | Obligation |
|----|-----------|------------|
| W-001 | `delegatecall` | Evidence disclosure |
| W-002 | Pragma isn't exactly `0.8.26` | Fix it — a floating pragma changes the bound runtime hash |
| W-003 | `Ownable` / `onlyOwner` / `Pausable` | Disclose privileged control |
| W-004 | `mint*` functions | Disclose supply effects |

Warnings never fail the run. They're disclosure obligations: declared is fine,
discovered in review is not.

### What it deliberately does not do

It is a lexical checker, not a compiler or a verifier. Comments and string literals are
blanked before scanning — `// never use selfdestruct here` must not be a violation, and
a checker that cries wolf gets switched off. Revert-only stubs are recognised as stubs,
not implementations, because `IHooks` forces you to declare all ten callbacks.

It cannot see anything requiring compilation or on-chain state: runtime byte size,
mined address bits, constructor materialization. Those are checked server-side at
admission.

### Exit codes

- `0` — no hard-block violations (warnings may be present)
- `1` — one or more hard-block violations

```bash
npx programmable-check ./src/ && forge build
```

---

## 5. Verifying the toolkit itself

```bash
npm run check:hook
```

```
  2 template(s): buyback-hook, creator-fee-hook

  PASS scaffold buyback-hook       clean (0 warning(s))
  PASS scaffold creator-fee-hook   clean (0 warning(s))

  PASS fixture detection      all 7 hard blocks fired
  PASS comment stripping      no findings from commented keywords
  PASS severity split         8 blocks, 5 warnings
```

Two failure modes this guards against, both of which would be invisible otherwise:
a template rotting into something that gets rejected, and the checker silently ceasing
to detect anything. `test/fixtures/BadHook.sol` breaks all seven hard blocks on purpose;
if any rule stops firing, this fails.

---

## 6. The AGENTS.md file

`AGENTS/AGENTS.md` is a machine-readable guide for AI coding assistants, and it is
**copied into every scaffolded project** as `AGENTS.md` at the repo root — which is where
Claude Code, Cursor, and Windsurf look.

It states the compiler pin, all 14 bit positions with which four are flags, the exact
callback return shapes, the forbidden and disclose-only patterns, the config fields that
fail silently, and what each lifecycle status means.

---

## 7. Adding new templates

1. Create `src/templates/<template-name>/` with `template.json`, `src/YourHook.sol` and
   `programmable-launch.config.json`. Use `{{PLACEHOLDER}}` tokens in the config and
   declare them under `variables` in `template.json` — the CLI generates its flags,
   help text, and validation from that.
2. Follow the existing contracts exactly:
   - `pragma solidity 0.8.26;` — exact, no caret
   - PoolManager injected via constructor, held `immutable`
   - `onlyPoolManager` on every effectful callback
   - `getHookPermissions()` true only for callbacks you actually implement
   - disabled callbacks as `revert HookNotImplemented();` stubs
3. Run `npm run check:hook`. Templates are discovered from disk, so there is no list to
   update — and the new one is checked automatically.

---

## 8. Publishing

From the monorepo root, after the SDK packages:

```bash
npm run build
npm run check:hook
npm publish -w packages/create-programmable-hook --access public
```

> ⚠️ `create-programmable-hook` is an **unscoped** name and may already be taken. Check
> with `npm view create-programmable-hook` first; if it's unavailable, publish as
> `@aabxtract/create-programmable-hook` and adjust the `npx` invocations in the generated
> README.

---

## 9. Why this exists

Programmable's builder flow is: drop an idea and an API key into their UI, and their AI
builds it. That's a black box — you don't control what was built, can't iterate locally,
and only learn about violations after submitting.

And the submission is **immutable**. A rejected request burns the attempt; you don't get
to amend it.

This CLI shifts the feedback earlier:

- **Scaffold locally** → understand exactly what you're shipping
- **Check locally** → catch all seven hard blocks before touching the API
- **Submit once** → then watch the lifecycle with `@aabxtract/programmable-sdk`

Reference: https://programmable.market/docs/developers/custom-launch
