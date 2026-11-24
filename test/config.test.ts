import { describe, expect, it } from "vitest";

import { buildAuthHeader, ConfigError, loadConfig, normalizeBaseUrl } from "../src/config.js";

const env = { WP_BASE_URL: "https://example.com/", WP_USERNAME: "editor", WP_APP_PASSWORD: "abcd efgh ijkl" };

describe("auth header", () => {
  it("is HTTP Basic with base64 of username:app-password", () => {
    const header = buildAuthHeader("editor", "abcd efgh ijkl");
    expect(header).toBe("Basic ZWRpdG9yOmFiY2QgZWZnaCBpamts");
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe("editor:abcd efgh ijkl");
  });

  it("encodes non-ASCII usernames as UTF-8", () => {
    const header = buildAuthHeader("zoë", "pw");
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe("zoë:pw");
  });
});

describe("HTTPS rule", () => {
  it("accepts https and strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeBaseUrl("https://example.com/blog/")).toBe("https://example.com/blog");
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080", "http://wp.localhost"])(
    "accepts plain http for local host %s",
    (url) => {
      expect(normalizeBaseUrl(url)).toBe(url);
    },
  );

  it.each(["http://example.com", "http://localhost.example.com", "http://192.168.1.20", "ftp://example.com"])(
    "refuses non-HTTPS remote URL %s",
    (url) => {
      expect(() => normalizeBaseUrl(url)).toThrow(ConfigError);
    },
  );

  it("refuses credentials inside the URL and malformed URLs", () => {
    expect(() => normalizeBaseUrl("https://user:pw@example.com")).toThrow(/credentials/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("reads the three required variables", () => {
    expect(loadConfig(env)).toEqual({
      baseUrl: "https://example.com",
      username: "editor",
      appPassword: "abcd efgh ijkl",
      readOnly: false,
    });
  });

  it("names the missing variables without echoing any values", () => {
    expect(() => loadConfig({ WP_BASE_URL: "https://example.com", WP_APP_PASSWORD: "" })).toThrow(
      "Missing required environment variables: WP_USERNAME, WP_APP_PASSWORD",
    );
  });

  it.each([["true", true], ["TRUE", true], ["1", true], ["false", false], ["", false], [undefined, false]])(
    "WP_READ_ONLY=%s gives readOnly=%s",
    (value, expected) => {
      expect(loadConfig({ ...env, WP_READ_ONLY: value }).readOnly).toBe(expected);
    },
  );
});
