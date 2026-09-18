/**
 * Fetch wrapper, error taxonomy, and response-envelope handling.
 */

import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  CHAIN_ID,
  DEFAULT_API_BASE_URL,
  DEFAULT_CUSTOM_LAUNCH_BASE_URL,
  DEFAULT_DISCOVERY_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  type ClientOptions,
  type LaunchFailure,
  type Origin,
  type RequestOptions,
  type Route,
} from "./types.js";

/** Base class for everything this SDK throws. Catch this to catch all of it. */
export class ProgrammableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Bad or missing configuration — wrong option, empty key. Not a network condition. */
export class ProgrammableConfigError extends ProgrammableError {}

/** An authenticated endpoint was called without a key. */
export class ProgrammableAuthError extends ProgrammableError {}

/**
 * The operation is real, documented, and deliberately not served by the public API.
 *
 * Distinct from a 404: retrying, fixing a path, or supplying a key will not help.
 * Carries `reason` so callers can surface the platform's own explanation.
 */
export class ProgrammableUnsupportedError extends ProgrammableError {
  readonly operation: string;
  readonly reason: string;

  constructor(operation: string, reason: string, guidance?: string) {
    super(`${operation} is not supported by the public API. ${reason}${guidance ? `\n\n${guidance}` : ""}`);
    this.operation = operation;
    this.reason = reason;
  }
}

/** A non-2xx HTTP response. */
export class ProgrammableHttpError extends ProgrammableError {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly method: string;
  /** Parsed JSON body, or the raw text when the body wasn't JSON. */
  readonly body: unknown;
  /** Populated from the `Retry-After` header on 429/503. Milliseconds. */
  readonly retryAfterMs?: number;
  /** From the error envelope or the `X-Request-Id` header — quote it in support reports. */
  readonly requestId?: string;
  /** Machine-readable code from the platform envelope, e.g. `NOT_FOUND`, `UNAUTHENTICATED`. */
  readonly code?: string;

  constructor(init: {
    status: number;
    statusText: string;
    url: string;
    method: string;
    body: unknown;
    retryAfterMs?: number;
    requestId?: string;
  }) {
    const envelope = readErrorEnvelope(init.body);

    super(
      `${init.method} ${init.url} failed: ${init.status} ${init.statusText}` +
        (envelope.code !== undefined ? ` (${envelope.code})` : "") +
        (envelope.message !== undefined ? ` — ${envelope.message}` : ""),
    );

    this.status = init.status;
    this.statusText = init.statusText;
    this.url = init.url;
    this.method = init.method;
    this.body = init.body;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (envelope.code !== undefined) this.code = envelope.code;

    const requestId = envelope.requestId ?? init.requestId;
    if (requestId !== undefined) this.requestId = requestId;
  }

  /** True when backing off and retrying is the correct response. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** True when the server is temporarily unable to serve, not permanently broken. */
  get isTransient(): boolean {
    return this.status === 429 || this.status === 503 || this.status >= 500;
  }
}

/**
 * Pull `code`, `message`, and `requestId` out of the platform's error envelope.
 *
 * Verified shape: `{ schemaVersion: "programmable.api-error.v1",
 * error: { code, message, requestId } }`. Tolerates a flat variant too, and returns
 * empty fields for anything unrecognized rather than throwing while constructing an
 * error — a parse failure here must never mask the HTTP failure being reported.
 */
function readErrorEnvelope(body: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
} {
  if (typeof body !== "object" || body === null) return {};

  const root = body as Record<string, unknown>;
  const nested = root["error"];
  const source = (
    typeof nested === "object" && nested !== null ? nested : root
  ) as Record<string, unknown>;

  const pick = (key: string): string | undefined =>
    typeof source[key] === "string" ? (source[key] as string) : undefined;

  return {
    ...(pick("code") !== undefined ? { code: pick("code") } : {}),
    ...(pick("message") !== undefined ? { message: pick("message") } : {}),
    ...(pick("requestId") !== undefined ? { requestId: pick("requestId") } : {}),
  };
}

/** A 2xx response whose shape we can't use — typically HTML where JSON was expected. */
export class ProgrammableResponseError extends ProgrammableError {
  readonly url: string;
  readonly contentType: string | null;
  readonly snippet: string;
  /** `content-type` when the body wasn't JSON at all; `shape` when it was JSON we couldn't read. */
  readonly reason: "content-type" | "shape";

  constructor(init: {
    url: string;
    contentType: string | null;
    snippet: string;
    detail: string;
    reason?: "content-type" | "shape";
  }) {
    super(`${init.url}: ${init.detail}`);
    this.url = init.url;
    this.contentType = init.contentType;
    this.snippet = init.snippet;
    this.reason = init.reason ?? "content-type";
  }
}

/**
 * The request never produced an HTTP response — DNS failure, refused or terminated
 * connection, TLS error.
 *
 * Kept distinct from ProgrammableHttpError because the remedy is opposite: a 404 means
 * fix your path, a terminated socket means retry. Collapsing the two sends people off
 * editing correct code because the network blipped.
 */
export class ProgrammableNetworkError extends ProgrammableError {
  readonly url: string;
  readonly method: string;

  constructor(method: string, url: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${method} ${url} could not complete: ${detail}`, { cause });
    this.url = url;
    this.method = method;
  }

  /** Always true — network faults are retryable by nature. */
  get isTransient(): boolean {
    return true;
  }
}

/** A request or a watch loop exceeded its deadline. */
export class ProgrammableTimeoutError extends ProgrammableError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.timeoutMs = timeoutMs;
  }
}

/** A watched launch entered a terminal failure state and will never reach the target. */
export class ProgrammableLaunchFailedError extends ProgrammableError {
  readonly launchId: string;
  readonly state: string;
  readonly failure?: LaunchFailure | null;

  constructor(
    launchId: string,
    state: string,
    targetState: string,
    failure?: LaunchFailure | null,
  ) {
    super(
      `Launch ${launchId} entered terminal state "${state}" and will never reach ` +
        `"${targetState}".` +
        (failure ? ` ${failure.code}: ${failure.message}` : ""),
    );
    this.launchId = launchId;
    this.state = state;
    if (failure !== undefined) this.failure = failure;
  }
}

/**
 * A watched launch is waiting on the caller, not on the server.
 *
 * Thrown instead of polling uselessly to the deadline: `action_required` and
 * `wallet_action_required` cannot advance without out-of-band action, so a timeout
 * would report "still waiting" and bury the actual reason.
 */
export class ProgrammableActionRequiredError extends ProgrammableError {
  readonly launchId: string;
  readonly state: string;
  readonly failure?: LaunchFailure | null;

  constructor(launchId: string, state: string, failure?: LaunchFailure | null) {
    super(
      `Launch ${launchId} is "${state}" and needs action from you before it can ` +
        `advance.` +
        (failure ? ` ${failure.code}: ${failure.message}` : "") +
        " Resolve it, then watch again — or pass { waitThroughActionRequired: true } " +
        "to keep polling if something else will resolve it.",
    );
    this.launchId = launchId;
    this.state = state;
    if (failure !== undefined) this.failure = failure;
  }
}

/**
 * Resolve the API key from an explicit option or the environment.
 *
 * Never silently falls back: an explicitly-empty value is a configuration mistake and
 * is reported as one. An entirely absent key is fine — the public read API needs none.
 */
export function resolveApiKey(explicit?: string): string | undefined {
  if (explicit !== undefined) {
    if (explicit.trim() === "") {
      throw new ProgrammableConfigError(
        "The `apiKey` option was provided but empty. Pass a real key, or omit the " +
          `option entirely to read ${API_KEY_ENV_VAR} from the environment.`,
      );
    }
    return explicit;
  }

  const fromEnv = process.env[API_KEY_ENV_VAR];
  if (fromEnv === undefined) return undefined;
  if (fromEnv.trim() === "") {
    throw new ProgrammableConfigError(
      `${API_KEY_ENV_VAR} is set but empty. Either set it to a real key or unset it — ` +
        "an empty value is almost always a .env that didn't load. " +
        "See BUILD_GUIDE.md §3 for loading it with `node --env-file=.env`.",
    );
  }
  return fromEnv;
}

/** `Retry-After` is either delta-seconds or an HTTP date. Handle both. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

export interface HttpRequestInit extends RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Require an API key; throw ProgrammableAuthError when none is configured. */
  auth?: boolean;
}

export class HttpClient {
  readonly origins: Record<Origin, string>;
  readonly chainId: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    const trim = (url: string) => url.replace(/\/+$/, "");

    this.origins = {
      discovery: trim(options.discoveryBaseUrl ?? DEFAULT_DISCOVERY_BASE_URL),
      api: trim(
        options.baseUrl ?? process.env[BASE_URL_ENV_VAR] ?? DEFAULT_API_BASE_URL,
      ),
      customLaunch: trim(options.customLaunchBaseUrl ?? DEFAULT_CUSTOM_LAUNCH_BASE_URL),
    };
    this.chainId = options.chainId ?? CHAIN_ID;
    this.apiKey = resolveApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = options.defaultHeaders ?? {};

    if (typeof this.fetchImpl !== "function") {
      throw new ProgrammableConfigError(
        "No global fetch available and no `fetch` option provided. Node 20.6+ is required.",
      );
    }
  }

  /** Whether an API key is configured. Authenticated calls fail without one. */
  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  /** The public read API origin — what most people mean by "the base URL". */
  get baseUrl(): string {
    return this.origins.api;
  }

  buildUrl(route: Route, query?: HttpRequestInit["query"]): string {
    const url = new URL(route.path, `${this.origins[route.origin]}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T>(route: Route, init: HttpRequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    const url = this.buildUrl(route, init.query);

    if (init.auth && this.apiKey === undefined) {
      throw new ProgrammableAuthError(
        `${method} ${route.path} requires an API key. Set ${API_KEY_ENV_VAR} or pass ` +
          "`apiKey` to createClient(). Get one at " +
          "https://programmable.market/developers/api-keys",
      );
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.defaultHeaders,
    };
    // Only attach credentials to the origin that asks for them.
    if (this.apiKey !== undefined && route.origin === "customLaunch") {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    if (init.body !== undefined) headers["content-type"] = "application/json";

    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        signal,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (cause) {
      // Distinguish our own deadline from a caller-initiated abort or a real network fault.
      if (timeoutSignal.aborted) {
        throw new ProgrammableTimeoutError(
          `${method} ${url} timed out after ${timeoutMs}ms.`,
          timeoutMs,
        );
      }
      if (init.signal?.aborted) throw cause;
      throw new ProgrammableNetworkError(method, url, cause);
    }

    const contentType = response.headers.get("content-type");
    const raw = await response.text();
    const parsed = isJsonContentType(contentType) ? safeJsonParse(raw) : raw;

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const requestId = response.headers.get("x-request-id");
      throw new ProgrammableHttpError({
        status: response.status,
        statusText: response.statusText,
        url,
        method,
        body: parsed,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId !== null ? { requestId } : {}),
      });
    }

    if (!isJsonContentType(contentType)) {
      throw new ProgrammableResponseError({
        url,
        contentType,
        snippet: raw.slice(0, 200),
        reason: "content-type",
        detail:
          `expected JSON but got ${contentType ?? "no content type"}. ` +
          "A 200 with HTML means this path is a web page, not an API route.",
      });
    }

    return parsed as T;
  }
}

function safeJsonParse(raw: string): unknown {
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Promise-based sleep that honours an AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
