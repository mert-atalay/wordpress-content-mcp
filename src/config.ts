/**
 * Configuration comes from environment variables only.
 * Credentials are kept in memory and never written to logs or tool output.
 */

export interface Config {
  /** Site root without a trailing slash, for example https://example.com */
  baseUrl: string;
  username: string;
  appPassword: string;
  /** When true, every write is refused and the write tools are not registered. */
  readOnly: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * Basic auth sends the application password with every request,
 * so plain HTTP is only accepted for a local machine.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("WP_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new ConfigError(
      "WP_BASE_URL must use https. Plain http is only allowed for localhost.",
    );
  }
  if (url.username || url.password) {
    throw new ConfigError("WP_BASE_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new ConfigError("WP_BASE_URL must not contain a query string or fragment.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ["WP_BASE_URL", "WP_USERNAME", "WP_APP_PASSWORD"].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return {
    baseUrl: normalizeBaseUrl(env.WP_BASE_URL as string),
    username: (env.WP_USERNAME as string).trim(),
    appPassword: (env.WP_APP_PASSWORD as string).trim(),
    readOnly: /^(true|1|yes)$/i.test((env.WP_READ_ONLY ?? "").trim()),
  };
}

/** Builds the HTTP Basic header used by WordPress application passwords. */
export function buildAuthHeader(username: string, appPassword: string): string {
  return "Basic " + Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64");
}
