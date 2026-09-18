import { HttpClient, ProgrammableConfigError } from "./http.js";
import type {
  Launch,
  LaunchCategory,
  ListLaunchesParams,
  ProgrammableModule,
  RequestOptions,
} from "./types.js";
import { LaunchesClient } from "./launches.js";

/**
 * Modules.
 *
 * ⚠️ THERE IS NO MODULES ENDPOINT. `/api/v2/modules` returns 404, and neither the v2
 * OpenAPI spec nor the v4 custom-launch spec defines a module registry. "Modules" are a
 * website concept (programmable.market/launch/modules), not an API resource.
 *
 * Rather than ship a client that only ever 404s, this derives modules from what launch
 * records actually declare on chain: `model: { id, version }` and `capabilities[]`.
 * That is real, verifiable data — but it is a projection of observed launches, not an
 * authoritative catalogue. A module nobody has launched with will not appear here.
 *
 * The platform's taxonomy also has no "family" level. `ProgrammableModule.family` is
 * this SDK's own grouping, set to the model id.
 */
export class ModulesClient {
  private readonly launches: LaunchesClient;

  constructor(private readonly http: HttpClient) {
    this.launches = new LaunchesClient(http);
  }

  /**
   * Distinct modules observed across indexed launches.
   *
   * Scans up to `maxPages` pages of the launch feed — this is a derived view, so it
   * costs several requests rather than one.
   */
  async list(
    params: ListLaunchesParams = {},
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<ProgrammableModule[]> {
    const launches = await this.launches.listAll(params, options);
    return deriveModules(launches);
  }

  /**
   * Modules matching a family, model id, or capability — e.g. "buyback".
   *
   * Matches case-insensitively against the model id and any declared capability, since
   * the platform has no formal family field. An empty result means no indexed launch
   * declares it, which is a real answer, not an error.
   */
  async getByFamily(
    family: string,
    params: ListLaunchesParams = {},
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<ProgrammableModule[]> {
    if (family.trim() === "") {
      throw new ProgrammableConfigError("getByFamily() requires a non-empty family.");
    }

    const wanted = family.trim().toLowerCase();
    const modules = await this.list(params, options);

    return modules.filter(
      (module) =>
        module.family.toLowerCase() === wanted ||
        module.id.toLowerCase() === wanted ||
        module.id.toLowerCase().includes(wanted) ||
        module.capabilities.some((capability) => capability.toLowerCase() === wanted),
    );
  }

  /** Distinct family names observed on chain. */
  async listFamilies(
    params: ListLaunchesParams = {},
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<string[]> {
    const modules = await this.list(params, options);
    return [...new Set(modules.map((module) => module.family))].sort();
  }
}

/** Fold launch records into a distinct module list, counting usage as we go. */
function deriveModules(launches: Launch[]): ProgrammableModule[] {
  const byKey = new Map<string, ProgrammableModule>();

  for (const launch of launches) {
    const id = launch.model?.id ?? launch.launch?.modelId;
    if (id === undefined || id === "") continue;

    const version = launch.model?.version ?? launch.launch?.modelVersion;
    const key = `${id}@${version ?? ""}`;

    let module = byKey.get(key);
    if (module === undefined) {
      module = {
        id,
        family: id,
        launchCount: 0,
        capabilities: [],
        categories: [],
        ...(version !== undefined ? { version } : {}),
      };
      byKey.set(key, module);
    }

    module.launchCount += 1;

    // capabilities[] holds objects like { id, version, status }, not bare strings.
    for (const capability of launch.capabilities ?? []) {
      const capabilityId = capability?.id;
      if (typeof capabilityId !== "string" || capabilityId === "") continue;
      if (!module.capabilities.includes(capabilityId)) {
        module.capabilities.push(capabilityId);
      }
    }

    const category = launch.category as LaunchCategory | undefined;
    if (category !== undefined && !module.categories.includes(category)) {
      module.categories.push(category);
    }
  }

  return [...byKey.values()].sort((a, b) => b.launchCount - a.launchCount);
}
