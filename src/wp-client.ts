/**
 * The single request layer. Every call to WordPress goes through WpClient.request,
 * and every request is checked by assertRequestAllowed before it is sent.
 *
 * The rules are an allowlist, not a blocklist:
 *   - GET is allowed.
 *   - POST to a content collection (for example /posts) is allowed only to create
 *     a new item with status "draft" or "pending".
 *   - POST to /media/{id} is allowed only when the body is exactly { alt_text }.
 *   - Everything else is refused. That covers DELETE, PUT, PATCH, updates to an
 *     existing post or page, and any status such as publish, private or future.
 */

import { buildAuthHeader, type Config } from "./config.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined;

export interface WpRequest {
  method: string;
  /** Path under /wp-json/wp/v2, for example "/posts" or "/media/12". */
  path: string;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
}

export interface WpResponse<T> {
  data: T;
  /** From the X-WP-Total header, when WordPress sends it. */
  total?: number;
  /** From the X-WP-TotalPages header, when WordPress sends it. */
  totalPages?: number;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(`Blocked by write guard: ${message}`);
    this.name = "GuardError";
  }
}

export class WpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WpApiError";
  }
}

export const ALLOWED_WRITE_STATUSES: readonly string[] = ["draft", "pending"];

const CREATE_FIELDS = new Set(["title", "content", "excerpt", "slug", "status"]);

/**
 * Core collections that are not editorial content. Creating items here could change
 * site settings, users or structure, so they are never writable, whatever the body says.
 */
const NON_CONTENT_COLLECTIONS = new Set([
  "media",
  "users",
  "comments",
  "settings",
  "plugins",
  "themes",
  "categories",
  "tags",
  "taxonomies",
  "types",
  "statuses",
  "search",
  "templates",
  "template-parts",
  "global-styles",
  "navigation",
  "menus",
  "menu-items",
  "menu-locations",
  "widgets",
  "widget-types",
  "sidebars",
  "block-types",
  "block-renderer",
  "block-directory",
  "pattern-directory",
  "font-families",
  "font-collections",
]);

const PATH_PATTERN = /^(\/[A-Za-z0-9_-]+)+$/;
const COLLECTION_PATTERN = /^\/([A-Za-z0-9_-]+)$/;
const MEDIA_ITEM_PATTERN = /^\/media\/\d+$/;

/** Throws GuardError unless the request is one this server is allowed to send. */
export function assertRequestAllowed(req: WpRequest, readOnly: boolean): void {
  const method = req.method.toUpperCase();

  if (!PATH_PATTERN.test(req.path)) {
    throw new GuardError(`path "${req.path}" is not a valid REST path.`);
  }
  for (const key of Object.keys(req.query ?? {})) {
    // WordPress lets a client override the HTTP method with ?_method=, and ?force= skips the trash.
    if (key.toLowerCase() === "_method" || key.toLowerCase() === "force") {
      throw new GuardError(`query parameter "${key}" is not allowed.`);
    }
  }

  if (method === "GET") {
    if (req.body !== undefined) throw new GuardError("GET requests cannot carry a body.");
    return;
  }
  if (method !== "POST") {
    throw new GuardError(`${method} requests are never sent. This server has no delete or update-in-place.`);
  }
  if (readOnly) {
    throw new GuardError("WP_READ_ONLY is set, so all writes are disabled.");
  }

  const body = req.body;
  if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new GuardError("POST requests need a JSON object body.");
  }
  const keys = Object.keys(body);

  if (MEDIA_ITEM_PATTERN.test(req.path)) {
    if (keys.length !== 1 || keys[0] !== "alt_text" || typeof body.alt_text !== "string") {
      throw new GuardError("the only allowed change to a media item is { alt_text: string }.");
    }
    return;
  }

  const collection = COLLECTION_PATTERN.exec(req.path)?.[1];
  if (!collection) {
    throw new GuardError(
      `POST ${req.path} would change an existing item. Only new drafts and media alt text can be written.`,
    );
  }
  if (NON_CONTENT_COLLECTIONS.has(collection.toLowerCase())) {
    throw new GuardError(`"${collection}" is not a content collection this server may write to.`);
  }
  const status = body.status;
  if (typeof status !== "string" || !ALLOWED_WRITE_STATUSES.includes(status)) {
    throw new GuardError(
      `status must be exactly "draft" or "pending". Got ${JSON.stringify(status)}. Publishing is left to a person.`,
    );
  }
  const extra = keys.filter((key) => !CREATE_FIELDS.has(key));
  if (extra.length > 0) {
    throw new GuardError(`fields not allowed when creating a draft: ${extra.join(", ")}.`);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export class WpClient {
  readonly baseUrl: string;
  readonly readOnly: boolean;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: Config, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = config.baseUrl;
    this.readOnly = config.readOnly;
    this.authHeader = buildAuthHeader(config.username, config.appPassword);
    this.fetchImpl = fetchImpl;
  }

  buildUrl(path: string, query: Record<string, QueryValue> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}/wp-json/wp/v2${path}${qs ? `?${qs}` : ""}`;
  }

  async request<T>(req: WpRequest): Promise<WpResponse<T>> {
    assertRequestAllowed(req, this.readOnly);

    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.authHeader,
    };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(req.path, req.query), {
        method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Only the method, path and cause are reported. Headers are never included.
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new WpApiError(`Request to WordPress failed (${method} ${req.path}): ${reason}`, 0);
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      throw new WpApiError(
        `WordPress returned a non-JSON response (HTTP ${response.status}) for ${method} ${req.path}. ` +
          "Check WP_BASE_URL and that the REST API is reachable at /wp-json.",
        response.status,
      );
    }

    if (!response.ok) {
      const err = (data ?? {}) as { code?: unknown; message?: unknown };
      const code = typeof err.code === "string" ? err.code : undefined;
      const message = typeof err.message === "string" ? err.message : response.statusText;
      throw new WpApiError(
        `WordPress API error ${response.status}${code ? ` (${code})` : ""} for ${method} ${req.path}: ${message}`,
        response.status,
        code,
      );
    }

    return {
      data: data as T,
      total: headerNumber(response, "X-WP-Total"),
      totalPages: headerNumber(response, "X-WP-TotalPages"),
    };
  }

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<WpResponse<T>> {
    return this.request<T>({ method: "GET", path, query });
  }

  post<T>(path: string, body: Record<string, unknown>): Promise<WpResponse<T>> {
    return this.request<T>({ method: "POST", path, body });
  }

  /**
   * Walks a paginated collection, starting at page 1, until WordPress reports no more
   * pages or maxPages is reached. `complete` is false when the walk stopped early.
   */
  async getPages<T>(
    path: string,
    query: Record<string, QueryValue>,
    options: { perPage?: number; maxPages?: number } = {},
  ): Promise<{ items: T[]; total: number | undefined; pagesFetched: number; complete: boolean }> {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 5;
    const items: T[] = [];
    let total: number | undefined;
    let totalPages = 1;
    let page = 0;
    while (page < maxPages && page < totalPages) {
      page += 1;
      const res = await this.get<T[]>(path, { ...query, per_page: perPage, page });
      items.push(...res.data);
      total = res.total ?? total;
      totalPages = res.totalPages ?? page;
    }
    return { items, total, pagesFetched: page, complete: page >= totalPages };
  }
}

function headerNumber(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? undefined : value;
}
