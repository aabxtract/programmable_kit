import { HttpClient, ProgrammableConfigError, ProgrammableHttpError } from "./http.js";
import { LaunchesClient } from "./launches.js";
import type {
  Launch,
  RequestOptions,
  SourceMatch,
  VerificationResult,
} from "./types.js";

/** Where the v4 backend publishes source verification on a promoted launch record. */
const V4_EXTENSION_KEY = "programmable/backend-finalized-v4";

const KNOWN_SOURCE_MATCHES: readonly SourceMatch[] = [
  "queued",
  "retrying",
  "exact_match",
  "needs_attention",
];

/**
 * Token source verification.
 *
 * ⚠️ There is no standalone verification endpoint — the build guide's
 * `/docs/developers/verify` is a documentation page, and requesting it returns HTML.
 * Verification status is published *on the launch record*, at
 * `extensions["programmable/backend-finalized-v4"].sourceVerification`, so this client
 * reads a launch and projects that field.
 *
 * Note the verdict vocabulary is `queued | retrying | exact_match | needs_attention` —
 * there is no "partial match". Per the v2 spec, "Blockscout observations alone never
 * establish an exact match"; only a durable Sourcify V2 exact result qualifies.
 */
export class VerifyClient {
  private readonly launches: LaunchesClient;

  constructor(private readonly http: HttpClient) {
    this.launches = new LaunchesClient(http);
  }

  async verifyToken(
    address: string,
    options: RequestOptions & { chainId?: number } = {},
  ): Promise<VerificationResult> {
    if (address.trim() === "") {
      throw new ProgrammableConfigError("verifyToken() requires a non-empty address.");
    }

    const chainId = options.chainId ?? this.http.chainId;

    let launch: Launch;
    try {
      launch = await this.launches.getByAddress(address, options);
    } catch (error) {
      // A 404 means "not an indexed launch", which is a verification answer in itself —
      // an unindexed token is definitionally unverified, not an error to propagate.
      if (error instanceof ProgrammableHttpError && error.status === 404) {
        return { address, chainId, sourceMatch: "unavailable" };
      }
      throw error;
    }

    return projectVerification(launch, address, chainId);
  }

  /** Read verification off a launch record you already have, without a second request. */
  fromLaunch(launch: Launch): VerificationResult {
    const address = launch.token?.address ?? "";
    const chainId = launch.chainId ?? this.http.chainId;
    return projectVerification(launch, address, chainId);
  }
}

function projectVerification(
  launch: Launch,
  address: string,
  chainId: number,
): VerificationResult {
  const extension = launch.extensions?.[V4_EXTENSION_KEY];
  const sourceVerification = isRecord(extension)
    ? extension["sourceVerification"]
    : undefined;

  const result: VerificationResult = {
    address: launch.token?.address ?? address,
    chainId: launch.chainId ?? chainId,
    sourceMatch: "unavailable",
  };

  if (launch.launchId !== undefined) result.launchId = launch.launchId;
  if (launch.verification?.provenanceStatus !== undefined) {
    result.provenanceStatus = launch.verification.provenanceStatus;
  }
  if (launch.verification?.sourceUrl !== undefined) {
    result.sourceUrl = launch.verification.sourceUrl;
  }

  if (isRecord(sourceVerification)) {
    result.sourceMatch = normalizeSourceMatch(sourceVerification["status"]);
    const updatedAt = sourceVerification["updatedAt"];
    if (typeof updatedAt === "string") result.updatedAt = updatedAt;
    const components = sourceVerification["components"];
    if (Array.isArray(components)) {
      result.components = components as Array<Record<string, unknown>>;
    }
  }

  return result;
}

/**
 * Coerce the verdict to a known value.
 *
 * Falls back to "unavailable" rather than guessing. An unrecognized status is a signal
 * the schema moved, and claiming a token is verified on a string we don't understand is
 * the one mistake worth engineering against here.
 */
function normalizeSourceMatch(value: unknown): SourceMatch {
  if (typeof value !== "string") return "unavailable";

  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  return (KNOWN_SOURCE_MATCHES as readonly string[]).includes(normalized)
    ? (normalized as SourceMatch)
    : "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
