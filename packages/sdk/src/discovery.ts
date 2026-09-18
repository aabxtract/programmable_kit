import { HttpClient, ProgrammableResponseError } from "./http.js";
import {
  ENDPOINTS,
  type ProgrammableManifest,
  type RequestOptions,
  type SubmissionStatus,
} from "./types.js";

export class DiscoveryClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * The well-known discovery manifest.
   *
   * This is the platform's own source of truth for origins, chains, and per-chain API
   * versions — it exists so "clients do not need a code change" when deployments move.
   * Prefer reading it over hardcoding anything.
   */
  async getManifest(options: RequestOptions = {}): Promise<ProgrammableManifest> {
    return this.http.request<ProgrammableManifest>(ENDPOINTS.manifest, options);
  }

  /** Platform status, including per-chain read-model health. */
  async getStatus(options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>(ENDPOINTS.status, options);
  }

  /**
   * Whether submissions are open.
   *
   * Returns the **API create** status, which is what matters when you're submitting
   * through this SDK. The manifest also carries a separate legacy registry/GitHub
   * intake status that has been closed for a while; conflating the two would report a
   * closed gate to callers who can in fact submit. Use `getSubmissionStatus()` when you
   * need both.
   */
  async isAcceptingSubmissions(options: RequestOptions = {}): Promise<boolean> {
    const status = await this.getSubmissionStatus(options);
    return status.apiCreateOpen;
  }

  /** Both submission gates, plus the raw status strings behind them. */
  async getSubmissionStatus(options: RequestOptions = {}): Promise<SubmissionStatus> {
    const manifest = await this.getManifest(options);
    const custom = manifest.publicCategories?.custom;

    if (custom === undefined) {
      throw new ProgrammableResponseError({
        url: this.http.buildUrl(ENDPOINTS.manifest),
        contentType: "application/json",
        snippet: JSON.stringify(manifest).slice(0, 200),
        reason: "shape",
        detail:
          "manifest has no publicCategories.custom block, so the submission gate " +
          "cannot be read. The manifest schema likely moved.",
      });
    }

    const publicApiCreateStatus = asString(custom["publicApiCreateStatus"]);
    const customLaunchApiStatus = asString(custom["customLaunchApiStatus"]);
    const publicSubmissionStatus = asString(custom["publicSubmissionStatus"]);
    const publicSubmissionStatusScope = asString(custom["publicSubmissionStatusScope"]);

    return {
      apiCreateOpen: isOpen(publicApiCreateStatus ?? customLaunchApiStatus),
      legacyIntakeOpen: isOpen(publicSubmissionStatus),
      raw: {
        ...(publicApiCreateStatus !== undefined ? { publicApiCreateStatus } : {}),
        ...(customLaunchApiStatus !== undefined ? { customLaunchApiStatus } : {}),
        ...(publicSubmissionStatus !== undefined ? { publicSubmissionStatus } : {}),
        ...(publicSubmissionStatusScope !== undefined
          ? { publicSubmissionStatusScope }
          : {}),
      },
    };
  }

  /**
   * Origins published by the manifest, for self-configuring a client.
   *
   * Returns undefined for any origin the manifest doesn't name, so callers can fall
   * back to the compiled-in default rather than to a broken URL.
   */
  async getOrigins(options: RequestOptions = {}): Promise<{
    api?: string;
    customLaunch?: string;
  }> {
    const manifest = await this.getManifest(options);
    const result: { api?: string; customLaunch?: string } = {};

    const api = originOf(manifest.apiBaseUrl ?? manifest.launchesUrl);
    if (api !== undefined) result.api = api;

    const customLaunch = originOf(manifest.agent?.apiBaseUrl);
    if (customLaunch !== undefined) result.customLaunch = customLaunch;

    return result;
  }
}

/** Reduce a full URL to its origin; the SDK appends its own paths. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isOpen(status: string | undefined): boolean {
  if (status === undefined) return false;
  return ["live", "open", "accepting", "enabled", "available"].includes(
    status.toLowerCase(),
  );
}
