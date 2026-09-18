/**
 * @programmable-devkit/sdk
 *
 * TypeScript SDK for the Programmable Market API, defaulting to Robinhood Chain
 * (chainId 4663).
 *
 * The platform spans three origins — discovery, the public v2 read API, and the
 * authenticated v4 custom-launch API. `createClient()` knows all three. Prefer
 * `createClientFromManifest()` if you want the platform's own manifest to configure
 * them, which is what it exists for.
 */

import { DiscoveryClient } from "./discovery.js";
import { HttpClient } from "./http.js";
import { LaunchesClient } from "./launches.js";
import { ModulesClient } from "./modules.js";
import { VerifyClient } from "./verify.js";
import type { ClientOptions } from "./types.js";

export class ProgrammableClient {
  readonly launches: LaunchesClient;
  readonly modules: ModulesClient;
  readonly verify: VerifyClient;
  readonly discovery: DiscoveryClient;
  /** Exposed so callers can reach routes the typed clients don't cover yet. */
  readonly http: HttpClient;

  constructor(options: ClientOptions = {}) {
    this.http = new HttpClient(options);
    this.launches = new LaunchesClient(this.http);
    this.modules = new ModulesClient(this.http);
    this.verify = new VerifyClient(this.http);
    this.discovery = new DiscoveryClient(this.http);
  }

  /** The public read API origin. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** All three configured origins. */
  get origins(): Readonly<Record<string, string>> {
    return this.http.origins;
  }

  /** Default chain for chain-scoped calls. */
  get chainId(): number {
    return this.http.chainId;
  }

  /** Whether authenticated calls will work. */
  get hasApiKey(): boolean {
    return this.http.hasApiKey;
  }
}

/**
 * Create a client.
 *
 * The API key is read from `PROGRAMMABLE_API_KEY` unless you pass one. Throws
 * immediately if the key is set but empty — a silent fallback there just turns into a
 * confusing 401 later.
 */
export function createClient(options: ClientOptions = {}): ProgrammableClient {
  return new ProgrammableClient(options);
}

/**
 * Create a client configured from the live discovery manifest.
 *
 * Costs one extra request at startup and, in exchange, survives the platform moving an
 * origin or adding a chain without an SDK release. Explicit options still win over
 * whatever the manifest says.
 */
export async function createClientFromManifest(
  options: ClientOptions = {},
): Promise<ProgrammableClient> {
  const bootstrap = new ProgrammableClient(options);
  const origins = await bootstrap.discovery.getOrigins();

  return new ProgrammableClient({
    ...options,
    ...(options.baseUrl === undefined && origins.api !== undefined
      ? { baseUrl: origins.api }
      : {}),
    ...(options.customLaunchBaseUrl === undefined && origins.customLaunch !== undefined
      ? { customLaunchBaseUrl: origins.customLaunch }
      : {}),
  });
}

export { DiscoveryClient, LaunchesClient, ModulesClient, VerifyClient, HttpClient };

export {
  ProgrammableActionRequiredError,
  ProgrammableAuthError,
  ProgrammableConfigError,
  ProgrammableError,
  ProgrammableHttpError,
  ProgrammableLaunchFailedError,
  ProgrammableNetworkError,
  ProgrammableResponseError,
  ProgrammableTimeoutError,
  ProgrammableUnsupportedError,
  resolveApiKey,
} from "./http.js";

export {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  CHAIN_ID,
  CUSTOM_LAUNCH_V4_CHAIN_ID,
  DEFAULT_API_BASE_URL,
  DEFAULT_CUSTOM_LAUNCH_BASE_URL,
  DEFAULT_DISCOVERY_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  DEFAULT_WATCH_TIMEOUT_MS,
  ENDPOINTS,
  ETHEREUM_CHAIN_ID,
  MIN_WATCH_INTERVAL_MS,
  STALLED_STATES,
  TERMINAL_FAILURE_STATES,
} from "./types.js";

export type {
  ClientOptions,
  CustomLaunchListPage,
  CustomLaunchStatus,
  FeedPage,
  FeedSnapshot,
  FeedStatus,
  Launch,
  LaunchCapability,
  LaunchCategory,
  LaunchEvent,
  LaunchFailure,
  LaunchFeed,
  LaunchState,
  LaunchToken,
  LaunchVerification,
  ListCustomLaunchesParams,
  ListLaunchesParams,
  Origin,
  ProgrammableManifest,
  ProgrammableModule,
  RequestOptions,
  Route,
  SourceMatch,
  SubmissionStatus,
  TokenMetadata,
  VerificationResult,
  WatchOptions,
} from "./types.js";
