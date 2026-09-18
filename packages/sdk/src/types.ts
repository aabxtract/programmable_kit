/**
 * Shared types, constants, and endpoint routes.
 *
 * These routes are NO LONGER INFERRED. They were validated on 2026-09-17 against:
 *   - https://programmable.market/.well-known/programmable.json  (discovery manifest)
 *   - https://developers.programmable.family/openapi/programmable-v2.yaml
 *   - https://programmable.market/openapi/custom-launch-v4.json
 *
 * The platform spans three origins, which is why there isn't one `baseUrl`:
 *   DISCOVERY  programmable.market              — the well-known manifest
 *   API        developers.programmable.family   — public launch/token reads (v2)
 *   CUSTOM     api.programmable.market          — authenticated custom-launch API (v4)
 *
 * The manifest publishes all of these, so prefer `createClientFromManifest()` over
 * hardcoding: the platform explicitly adds new chains and deployments there "so clients
 * do not need a code change."
 */

/** Robinhood Chain Mainnet. */
export const CHAIN_ID = 4663;
/** Ethereum Mainnet — the other chain the platform indexes. */
export const ETHEREUM_CHAIN_ID = 1;

/**
 * The only chain the v4 custom-launch API serves.
 *
 * Verified: any other value returns 400 `CUSTOM_LAUNCH_CHAIN_MISMATCH` — "V4 path
 * chainId must be 4663". Ethereum custom launches live on the separate v3 API, which
 * this SDK does not yet cover. The public v2 read API is multi-chain; only this one is
 * pinned.
 */
export const CUSTOM_LAUNCH_V4_CHAIN_ID = 4663;

/** Origin serving the well-known discovery manifest. */
export const DEFAULT_DISCOVERY_BASE_URL = "https://programmable.market";
/** Origin serving the public v2 read API. */
export const DEFAULT_API_BASE_URL = "https://developers.programmable.family";
/** Origin serving the authenticated v4 custom-launch API. */
export const DEFAULT_CUSTOM_LAUNCH_BASE_URL = "https://api.programmable.market";

export const API_KEY_ENV_VAR = "PROGRAMMABLE_API_KEY";
export const BASE_URL_ENV_VAR = "PROGRAMMABLE_BASE_URL";

export const DEFAULT_TIMEOUT_MS = 30_000;

export const DEFAULT_WATCH_INTERVAL_MS = 5_000;
export const DEFAULT_WATCH_TIMEOUT_MS = 300_000;
/** Floor on poll interval — a tighter loop trips rate limits, it doesn't go faster. */
export const MIN_WATCH_INTERVAL_MS = 1_000;

/** Which origin a route belongs to. */
export type Origin = "discovery" | "api" | "customLaunch";

export const ENDPOINTS = {
  /** Discovery origin. */
  manifest: { origin: "discovery" as Origin, path: "/.well-known/programmable.json" },

  /** API origin — public reads, no key required. */
  status: { origin: "api" as Origin, path: "/api/v2/status" },
  platformManifest: { origin: "api" as Origin, path: "/api/v2/manifest" },
  chainManifest: (chainId: number) => ({
    origin: "api" as Origin,
    path: `/api/v2/manifests/${chainId}`,
  }),
  launches: { origin: "api" as Origin, path: "/api/v2/launches" },
  launchByToken: (chainId: number, tokenAddress: string) => ({
    origin: "api" as Origin,
    path: `/api/v2/launches/${chainId}/${encodeURIComponent(tokenAddress)}`,
  }),
  launchById: (launchId: string) => ({
    origin: "api" as Origin,
    path: `/api/v2/launches/${encodeURIComponent(launchId)}`,
  }),
  tokenList: { origin: "api" as Origin, path: "/api/v2/token-list" },

  /** Custom-launch origin — v4, requires a Bearer API key. */
  customLaunches: (chainId: number) => ({
    origin: "customLaunch" as Origin,
    path: `/v4/chains/${chainId}/custom-launches`,
  }),
  customLaunchById: (chainId: number, launchId: string) => ({
    origin: "customLaunch" as Origin,
    path: `/v4/chains/${chainId}/custom-launches/${encodeURIComponent(launchId)}`,
  }),
  customLaunchCapabilities: (chainId: number) => ({
    origin: "customLaunch" as Origin,
    path: `/v4/chains/${chainId}/capabilities`,
  }),
} as const;

export interface Route {
  origin: Origin;
  path: string;
}

/** Feed quality. `degraded` still returns real records — it isn't an error. */
export type FeedStatus = "live" | "degraded" | "unavailable";

/** Stable public launch taxonomy. */
export type LaunchCategory = "classic" | "custom";

/**
 * Custom launch lifecycle, from the v4 OpenAPI `status` enum.
 *
 * `authorized` is the state the guide's wallet-handoff example waits for; it's when
 * `walletHandoffUrl` becomes available. `finalized` is terminal success, `failed`
 * terminal failure.
 */
export type LaunchState =
  | "received"
  | "validating"
  | "action_required"
  | "authorized"
  | "awaiting_wallet_signature"
  | "wallet_action_required"
  | "submitted"
  | "sequencer_soft_confirmed"
  | "ethereum_posted"
  | "finalized"
  | "failed";

/** States a launch cannot move out of. `watchUntil` stops when it hits one. */
export const TERMINAL_FAILURE_STATES: readonly LaunchState[] = ["failed"];

/**
 * States that will not advance without the caller doing something out of band.
 *
 * Polling through these is pointless: an unattended `watchUntil` would spin until its
 * deadline and then report a timeout, hiding the real reason. Verified against live
 * account data — `action_required` launches carry a `failure.code` explaining what to
 * fix, e.g. `ROBINHOOD_INITIAL_BUY_BELOW_ONE_USD_REFERENCE`.
 */
export const STALLED_STATES: readonly LaunchState[] = [
  "action_required",
  "wallet_action_required",
];

/**
 * Source verification verdict, from the v4 `source-verification-status.v4` schema.
 *
 * Note this is NOT the `exact_match | partial_match | unverified` triple the build
 * guide assumed. There is no "partial" — per the v2 spec, "Blockscout observations
 * alone never establish an exact match", and anything short of a durable Sourcify V2
 * exact result lands in `needs_attention`.
 *
 * `unavailable` is this SDK's own value for "the server published no status yet",
 * which the schema represents as an absent/null field.
 */
export type SourceMatch =
  | "queued"
  | "retrying"
  | "exact_match"
  | "needs_attention"
  | "unavailable";

export interface TokenMetadata {
  description?: string | null;
  imageUrl?: string | null;
  links?: Record<string, string> | null;
  /** `sanitized` | `unavailable` — whether the platform vetted the metadata. */
  trustStatus?: string;
}

export interface LaunchToken {
  address: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  identityStatus?: string;
  /** Raw integer string, not a number — supply exceeds Number.MAX_SAFE_INTEGER. */
  totalSupplyRaw?: string | null;
  supplyStatus?: string;
  supplyAsOfBlock?: string | null;
  metadata?: TokenMetadata;
}

export interface LaunchEvent {
  status?: string;
  origin?: string;
  modelId?: string;
  modelVersion?: string;
  publicSubmission?: boolean;
  creatorAddress?: string;
  transactionHash?: string;
  blockNumber?: string;
  blockHash?: string;
  transactionIndex?: number;
  logIndex?: number;
  timestamp?: string;
  finality?: string;
}

/**
 * A capability declared by a launch.
 *
 * Note this is an object, not a bare string — e.g.
 * `{ id: "project-only", version: "1.0.0", status: "active", parameters: {} }`.
 */
export interface LaunchCapability {
  id: string;
  version?: string;
  status?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LaunchVerification {
  sourceId?: string;
  launcherAddress?: string | null;
  registryAddress?: string | null;
  /** e.g. "verified". Provenance of the launch itself, not of the token source code. */
  provenanceStatus?: string;
  sourceUrl?: string | null;
}

/**
 * A normalized launch record from `/api/v2/launches`.
 *
 * The index signature is retained deliberately: the platform's compatibility contract
 * is `additiveChangesOnly` with `unknownFields: ignore`, so new fields will appear and
 * should pass through rather than be dropped.
 */
export interface Launch {
  schemaVersion?: string;
  platformId?: string;
  publicLabel?: string;
  launchId: string;
  category?: LaunchCategory;
  chainId?: number;
  caip2?: string;
  projectId?: string | null;
  model?: { id?: string; version?: string };
  token?: LaunchToken;
  launch?: LaunchEvent;
  verification?: LaunchVerification;
  capabilities?: LaunchCapability[];
  markets?: Array<Record<string, unknown>>;
  fees?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FeedPage {
  /** Continue traversing the current page set. */
  nextCursor?: string | null;
  /** Persist this after a completed poll and pass it back as `after`. */
  resumeCursor?: string | null;
  hasMore?: boolean;
}

export interface FeedSnapshot {
  blockNumber?: string;
  blockHash?: string;
  indexedAt?: string;
  finality?: string;
  sources?: Record<string, unknown>;
}

/** The full `/api/v2/launches` envelope. */
export interface LaunchFeed {
  schemaVersion?: string;
  status: FeedStatus;
  snapshot?: FeedSnapshot;
  items: Launch[];
  page?: FeedPage;
}

export interface ListLaunchesParams {
  /** Defaults to Robinhood Chain (4663). Pass `null` for all chains. */
  chainId?: number | null;
  category?: LaunchCategory;
  limit?: number;
  /** Resume token from a previous completed poll. Mutually exclusive with `cursor`. */
  after?: string;
  /** Continue the current page traversal. Mutually exclusive with `after`. */
  cursor?: string;
}

/**
 * A "module" as this SDK reports it.
 *
 * ⚠️ DERIVED, NOT OFFICIAL. The platform publishes no modules endpoint — see
 * ModulesClient. These are assembled from the `model` and `capabilities` fields that
 * real launch records declare on chain.
 */
export interface ProgrammableModule {
  /** Model id, e.g. "custom-graph". */
  id: string;
  /** Model version, e.g. "programmable-launch-stamp-router-v1". */
  version?: string;
  /** Coarse grouping this SDK derives from the model id. */
  family: string;
  /** How many indexed launches declare it — a usage signal, not an endorsement. */
  launchCount: number;
  /** Distinct capability ids observed alongside this model. */
  capabilities: string[];
  /** Whether it was seen on classic launches, custom launches, or both. */
  categories: LaunchCategory[];
}

export interface VerificationResult {
  address: string;
  chainId: number;
  launchId?: string;
  /** Token source-code verification verdict. */
  sourceMatch: SourceMatch;
  /** Provenance of the launch record itself, e.g. "verified". Distinct from sourceMatch. */
  provenanceStatus?: string;
  sourceUrl?: string | null;
  updatedAt?: string;
  /** Per-target breakdown when the server publishes one. */
  components?: Array<Record<string, unknown>>;
}

export interface SubmissionStatus {
  /**
   * Whether the v4 custom-launch API accepts creates. This is the one that matters for
   * SDK/agent submission.
   */
  apiCreateOpen: boolean;
  /** Whether the legacy registry/GitHub intake accepts submissions. Long closed. */
  legacyIntakeOpen: boolean;
  /** Raw status strings, for when the booleans flatten too much detail. */
  raw: {
    publicApiCreateStatus?: string;
    customLaunchApiStatus?: string;
    publicSubmissionStatus?: string;
    publicSubmissionStatusScope?: string;
  };
}

export interface ProgrammableManifest {
  schemaVersion?: string;
  platformId?: string;
  name?: string;
  description?: string;
  apiVersion?: string;
  apiBaseUrl?: string;
  statusUrl?: string;
  manifestUrl?: string;
  launchesUrl?: string;
  tokenListUrl?: string;
  openApiUrl?: string;
  documentationUrl?: string;
  agent?: {
    apiBaseUrl?: string;
    guideUrl?: string;
    docsIndexUrl?: string;
    website?: Record<string, string>;
    workflows?: Record<string, unknown>;
    [key: string]: unknown;
  };
  chains?: Array<{
    chainId: number;
    caip2?: string;
    name?: string;
    status?: string;
    customLaunchApiVersion?: string;
    [key: string]: unknown;
  }>;
  publicCategories?: {
    classic?: Record<string, unknown>;
    custom?: Record<string, unknown>;
  };
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A problem or required action reported on a launch.
 *
 * Present on `failed` launches (e.g. `PERMIT_EXPIRED`) and also on `action_required`
 * ones (e.g. `ROBINHOOD_INITIAL_BUY_BELOW_ONE_USD_REFERENCE`), so its presence alone
 * does not mean the launch is dead — check `status`.
 */
export interface LaunchFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Response of `GET /v4/chains/{chainId}/custom-launches/{launchId}`. */
export interface CustomLaunchStatus {
  launchId: string;
  status: LaunchState;
  /** NOTE: the v4 API returns this as a **string** (`"4663"`), unlike the v2 read API. */
  chainId?: string | number;
  caip2?: string;
  requestId?: string;
  /** Present once the launch reaches a state needing a wallet signature; null before. */
  walletHandoffUrl?: string | null;
  expiresAt?: string | null;
  secondsRemaining?: number | null;
  actionRequired?: unknown;
  sourceVerification?: {
    status?: string;
    components?: Array<Record<string, unknown>>;
    updatedAt?: string;
    [key: string]: unknown;
  } | null;
  failure?: LaunchFailure | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Response of `GET /v4/chains/{chainId}/custom-launches`. */
export interface CustomLaunchListPage {
  schemaVersion?: string;
  apiVersion?: string;
  /** String, per the v4 API. */
  chainId?: string;
  caip2?: string;
  generatedAt?: string;
  launches: CustomLaunchStatus[];
  /** Pass back as `cursor` to continue. Null when exhausted. */
  nextCursor?: string | null;
}

export interface ListCustomLaunchesParams {
  chainId?: number;
  limit?: number;
  cursor?: string;
}

export interface ClientOptions {
  /**
   * Public read API origin (v2). Defaults to https://developers.programmable.family,
   * or `PROGRAMMABLE_BASE_URL` if set.
   */
  baseUrl?: string;
  /** Discovery origin serving the well-known manifest. */
  discoveryBaseUrl?: string;
  /** Authenticated v4 custom-launch API origin. */
  customLaunchBaseUrl?: string;
  /** Default chain for chain-scoped calls. Defaults to 4663 (Robinhood Chain). */
  chainId?: number;
  /**
   * API key (`pm_live_*`). Defaults to `PROGRAMMABLE_API_KEY`. Passing an empty string
   * throws rather than falling back to the environment.
   */
  apiKey?: string;
  /** Injectable fetch, for tests or a proxy agent. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WatchOptions extends RequestOptions {
  /** Poll interval in ms. Default 5_000, floor 1_000. */
  intervalMs?: number;
  /** Give up after this long. Default 300_000. Throws ProgrammableTimeoutError. */
  timeoutMs?: number;
  /** Chain to poll. Defaults to the client's chainId. */
  chainId?: number;
  /**
   * Keep polling through `action_required` / `wallet_action_required` instead of
   * throwing. Only useful when something outside this process will resolve the action.
   */
  waitThroughActionRequired?: boolean;
  /** Called after each poll — log progress without wrapping the call. */
  onPoll?: (status: CustomLaunchStatus, pollCount: number) => void;
}
