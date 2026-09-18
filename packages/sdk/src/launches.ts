import {
  HttpClient,
  ProgrammableActionRequiredError,
  ProgrammableConfigError,
  ProgrammableLaunchFailedError,
  ProgrammableResponseError,
  ProgrammableTimeoutError,
  ProgrammableUnsupportedError,
  sleep,
} from "./http.js";
import {
  CUSTOM_LAUNCH_V4_CHAIN_ID,
  DEFAULT_WATCH_INTERVAL_MS,
  DEFAULT_WATCH_TIMEOUT_MS,
  ENDPOINTS,
  MIN_WATCH_INTERVAL_MS,
  STALLED_STATES,
  TERMINAL_FAILURE_STATES,
  type CustomLaunchListPage,
  type CustomLaunchStatus,
  type Launch,
  type LaunchFeed,
  type LaunchState,
  type ListCustomLaunchesParams,
  type ListLaunchesParams,
  type RequestOptions,
  type WatchOptions,
} from "./types.js";

/** Cap on auto-pagination, so a degraded feed can't spin forever. */
const MAX_AUTO_PAGES = 20;

/**
 * Reject a v4 custom-launch call on the wrong chain before spending a request.
 *
 * The server answers 400 `CUSTOM_LAUNCH_CHAIN_MISMATCH`, which is clear enough once you
 * read the body — but the client already knows this is impossible, and saying so up
 * front beats a round trip plus an error you have to decode.
 */
function assertV4Chain(chainId: number, operation: string): void {
  if (chainId === CUSTOM_LAUNCH_V4_CHAIN_ID) return;

  throw new ProgrammableConfigError(
    `${operation} is only available on chain ${CUSTOM_LAUNCH_V4_CHAIN_ID} ` +
      `(Robinhood Chain); got ${chainId}. The v4 custom-launch API serves that chain ` +
      "only — Ethereum custom launches use the separate v3 API, which this SDK does " +
      "not cover yet. The public read API (launches.list, getByAddress) is multi-chain.",
  );
}

export class LaunchesClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * One page of the launch feed, with the envelope intact.
   *
   * Prefer this over `list()` when you care about `status` or need to paginate:
   * a `degraded` feed still returns real records, so it is not an error, but it does
   * mean absence is not authoritative — don't conclude a token is missing from it.
   */
  async listPage(
    params: ListLaunchesParams = {},
    options: RequestOptions = {},
  ): Promise<LaunchFeed> {
    if (params.after !== undefined && params.cursor !== undefined) {
      throw new ProgrammableConfigError(
        "`after` and `cursor` must not be sent together. Use `after` to resume a " +
          "completed poll, `cursor` to continue the current traversal.",
      );
    }

    const chainId = params.chainId === undefined ? this.http.chainId : params.chainId;

    const feed = await this.http.request<LaunchFeed>(ENDPOINTS.launches, {
      query: {
        ...(chainId !== null ? { chainId } : {}),
        category: params.category,
        limit: params.limit,
        after: params.after,
        cursor: params.cursor,
      },
      ...options,
    });

    if (!Array.isArray(feed?.items)) {
      throw new ProgrammableResponseError({
        url: this.http.buildUrl(ENDPOINTS.launches),
        contentType: "application/json",
        snippet: JSON.stringify(feed).slice(0, 200),
        reason: "shape",
        detail: "launch feed had no `items` array.",
      });
    }

    return feed;
  }

  /** Launch records from a single page. No API key required. */
  async list(
    params: ListLaunchesParams = {},
    options: RequestOptions = {},
  ): Promise<Launch[]> {
    const feed = await this.listPage(params, options);
    return feed.items;
  }

  /**
   * Follow `page.nextCursor` until the feed is exhausted.
   *
   * Stops at {@link MAX_AUTO_PAGES} pages. Each page is one request against your quota.
   */
  async listAll(
    params: ListLaunchesParams = {},
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<Launch[]> {
    const maxPages = options.maxPages ?? MAX_AUTO_PAGES;
    const all: Launch[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const feed = await this.listPage(
        { ...params, ...(cursor !== undefined ? { cursor } : {}) },
        options,
      );
      all.push(...feed.items);

      const next = feed.page?.nextCursor;
      if (feed.page?.hasMore !== true || next === null || next === undefined) break;
      cursor = next;
    }

    return all;
  }

  /**
   * The `limit` most recently launched tokens.
   *
   * The feed is not guaranteed to be time-ordered, so this sorts by launch timestamp
   * rather than trusting arrival order.
   */
  async getRecent(
    limit = 10,
    params: ListLaunchesParams = {},
    options: RequestOptions = {},
  ): Promise<Launch[]> {
    const launches = await this.list({ ...params, limit }, options);

    return [...launches]
      .sort((a, b) => {
        const left = Date.parse(a.launch?.timestamp ?? "");
        const right = Date.parse(b.launch?.timestamp ?? "");
        if (Number.isNaN(left) && Number.isNaN(right)) return 0;
        if (Number.isNaN(left)) return 1;
        if (Number.isNaN(right)) return -1;
        return right - left;
      })
      .slice(0, limit);
  }

  /** A single launch by token contract address. */
  async getByAddress(
    address: string,
    options: RequestOptions & { chainId?: number } = {},
  ): Promise<Launch> {
    if (address.trim() === "") {
      throw new ProgrammableConfigError("getByAddress() requires a non-empty address.");
    }
    const chainId = options.chainId ?? this.http.chainId;
    return this.http.request<Launch>(ENDPOINTS.launchByToken(chainId, address), options);
  }

  /** A single launch by its platform launch id. */
  async getById(launchId: string, options: RequestOptions = {}): Promise<Launch> {
    if (launchId.trim() === "") {
      throw new ProgrammableConfigError("getById() requires a non-empty launchId.");
    }
    return this.http.request<Launch>(ENDPOINTS.launchById(launchId), options);
  }

  /**
   * Stock-paired launches.
   *
   * ⚠️ NOT AVAILABLE. The v2 API spec states plainly: "Stock-Paired launches are
   * excluded from active API v2 Developer discovery and scanning." No public endpoint
   * exposes the equity pairing, and no launch record carries a ticker field.
   *
   * This throws rather than returning `[]`, because an empty array here reads as "no
   * NVDA tokens exist" when the truth is "this API will not tell you." Returning a
   * confident wrong answer is the worse failure.
   */
  async getStockPaired(symbol?: string): Promise<Launch[]> {
    throw new ProgrammableUnsupportedError(
      `launches.getStockPaired(${symbol ? `"${symbol}"` : ""})`,
      'The v2 API spec states: "Stock-Paired launches are excluded from active API v2 ' +
        'Developer discovery and scanning." Only a frozen v1 compatibility snapshot ' +
        "retains Stock-Paired history, and it exposes no ticker field either.",
      "If Stock scanning is reactivated, implement this against the ticker field the " +
        "launch record gains at that point. Until then there is no data source to read.",
    );
  }

  /**
   * Lifecycle status of a custom launch from the v4 API. **Requires an API key.**
   *
   * `GET /v4/chains/{chainId}/custom-launches/{launchId}`
   */
  async getStatus(
    launchId: string,
    options: RequestOptions & { chainId?: number } = {},
  ): Promise<CustomLaunchStatus> {
    if (launchId.trim() === "") {
      throw new ProgrammableConfigError("getStatus() requires a non-empty launchId.");
    }
    const chainId = options.chainId ?? this.http.chainId;
    assertV4Chain(chainId, "getStatus()");

    return this.http.request<CustomLaunchStatus>(
      ENDPOINTS.customLaunchById(chainId, launchId),
      { auth: true, ...options },
    );
  }

  /**
   * List your account's custom launches. **Requires an API key.**
   *
   * `GET /v4/chains/{chainId}/custom-launches` — this is how you discover launch ids
   * in the first place; everything else in the v4 flow needs one.
   */
  async listCustomLaunches(
    params: ListCustomLaunchesParams = {},
    options: RequestOptions = {},
  ): Promise<CustomLaunchListPage> {
    const chainId = params.chainId ?? this.http.chainId;
    assertV4Chain(chainId, "listCustomLaunches()");

    const page = await this.http.request<CustomLaunchListPage>(
      ENDPOINTS.customLaunches(chainId),
      {
        auth: true,
        query: { limit: params.limit, cursor: params.cursor },
        ...options,
      },
    );

    if (!Array.isArray(page?.launches)) {
      throw new ProgrammableResponseError({
        url: this.http.buildUrl(ENDPOINTS.customLaunches(chainId)),
        contentType: "application/json",
        snippet: JSON.stringify(page).slice(0, 200),
        reason: "shape",
        detail: "custom launch list had no `launches` array.",
      });
    }

    return page;
  }

  /**
   * Poll until a launch reaches `targetState`, then resolve so you can hand off to
   * wallet signing.
   *
   * Costs one request per interval against your quota — worst case
   * `timeoutMs / intervalMs` calls. Requires an API key.
   *
   * Throws ProgrammableTimeoutError on expiry and ProgrammableLaunchFailedError if the
   * launch fails, so a stuck launch surfaces as an error rather than an unbounded loop.
   */
  async watchUntil(
    launchId: string,
    targetState: LaunchState,
    options: WatchOptions = {},
  ): Promise<CustomLaunchStatus> {
    const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;

    if (intervalMs < MIN_WATCH_INTERVAL_MS) {
      throw new ProgrammableConfigError(
        `intervalMs of ${intervalMs}ms is below the ${MIN_WATCH_INTERVAL_MS}ms floor. ` +
          "Polling faster trips rate limits, it doesn't get the answer sooner.",
      );
    }
    if (timeoutMs <= 0) {
      throw new ProgrammableConfigError("timeoutMs must be positive.");
    }

    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    for (;;) {
      const status = await this.getStatus(launchId, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.chainId !== undefined ? { chainId: options.chainId } : {}),
      });
      pollCount += 1;
      options.onPoll?.(status, pollCount);

      if (status.status === targetState) return status;

      if (TERMINAL_FAILURE_STATES.includes(status.status)) {
        throw new ProgrammableLaunchFailedError(
          launchId,
          status.status,
          targetState,
          status.failure,
        );
      }

      // Polling can't resolve these — stop and say why instead of timing out vaguely.
      if (
        STALLED_STATES.includes(status.status) &&
        options.waitThroughActionRequired !== true
      ) {
        throw new ProgrammableActionRequiredError(
          launchId,
          status.status,
          status.failure,
        );
      }

      // Stop before a sleep that would overshoot the deadline anyway.
      if (Date.now() + intervalMs >= deadline) {
        throw new ProgrammableTimeoutError(
          `Launch ${launchId} was still "${status.status}" after ${pollCount} polls ` +
            `(${timeoutMs}ms); gave up waiting for "${targetState}".`,
          timeoutMs,
        );
      }

      await sleep(intervalMs, options.signal);
    }
  }
}
