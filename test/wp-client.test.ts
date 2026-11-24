import { describe, expect, it } from "vitest";

import { buildAuthHeader } from "../src/config.js";
import { assertRequestAllowed, GuardError, WpApiError, WpClient, type WpRequest } from "../src/wp-client.js";
import { CONFIG, fakeSite, fixture, mockFetch, SITE } from "./helpers.js";

const draft = { title: "T", content: "<p>C</p>", status: "draft" };

describe("write guard: allowed requests", () => {
  it.each<[string, WpRequest]>([
    ["GET a collection", { method: "GET", path: "/posts", query: { per_page: 10 } }],
    ["GET one item", { method: "GET", path: "/pages/42" }],
    ["create a draft post", { method: "POST", path: "/posts", body: draft }],
    ["create a pending page", { method: "POST", path: "/pages", body: { ...draft, status: "pending", excerpt: "E", slug: "s" } }],
    ["create a draft of a custom type", { method: "POST", path: "/workshops", body: draft }],
    ["set media alt text", { method: "POST", path: "/media/88", body: { alt_text: "A bike" } }],
  ])("%s", (_name, req) => {
    expect(() => assertRequestAllowed(req, false)).not.toThrow();
  });
});

describe("write guard: refused requests", () => {
  it.each(["publish", "private", "future", "trash", "Publish", "PUBLISH", " draft", ""])(
    "refuses status %j on create",
    (status) => {
      expect(() => assertRequestAllowed({ method: "POST", path: "/posts", body: { ...draft, status } }, false)).toThrow(GuardError);
    },
  );

  it("refuses a create with no status, or a non-string status", () => {
    expect(() => assertRequestAllowed({ method: "POST", path: "/posts", body: { title: "T", content: "C" } }, false)).toThrow(/status/);
    expect(() => assertRequestAllowed({ method: "POST", path: "/posts", body: { ...draft, status: ["publish"] } }, false)).toThrow(GuardError);
  });

  it.each(["DELETE", "delete", "PUT", "PATCH", "HEAD", "OPTIONS"])("refuses %s on any path", (method) => {
    expect(() => assertRequestAllowed({ method, path: "/posts/42" }, false)).toThrow(GuardError);
    expect(() => assertRequestAllowed({ method, path: "/media/88" }, false)).toThrow(GuardError);
  });

  it("refuses any POST to an existing post or page, even with status draft", () => {
    for (const path of ["/posts/42", "/pages/42", "/workshops/7", "/posts/42/revisions", "/pages/42/autosaves"]) {
      expect(() => assertRequestAllowed({ method: "POST", path, body: draft }, false)).toThrow(/existing item/);
    }
  });

  it("refuses the method override and force parameters", () => {
    expect(() => assertRequestAllowed({ method: "GET", path: "/posts/42", query: { _method: "DELETE" } }, false)).toThrow(GuardError);
    expect(() => assertRequestAllowed({ method: "POST", path: "/posts", query: { _method: "DELETE" }, body: draft }, false)).toThrow(GuardError);
    expect(() => assertRequestAllowed({ method: "GET", path: "/posts/42", query: { force: true } }, false)).toThrow(GuardError);
  });

  it("refuses extra fields on create", () => {
    for (const extra of [{ author: 1 }, { meta: { a: 1 } }, { password: "x" }, { date: "2020-01-01T00:00:00" }, { sticky: true }]) {
      expect(() => assertRequestAllowed({ method: "POST", path: "/posts", body: { ...draft, ...extra } }, false)).toThrow(/not allowed/);
    }
  });

  it("refuses media writes other than exactly { alt_text }", () => {
    const bad = [{ alt_text: "A", status: "publish" }, { title: "New" }, { alt_text: "A", post: 1 }, { alt_text: 5 }, {}];
    for (const body of bad) {
      expect(() => assertRequestAllowed({ method: "POST", path: "/media/88", body }, false)).toThrow(GuardError);
    }
    expect(() => assertRequestAllowed({ method: "POST", path: "/media", body: { ...draft } }, false)).toThrow(GuardError);
  });

  it.each(["settings", "users", "comments", "plugins", "themes", "categories", "tags", "Settings"])(
    "refuses writes to the non-content collection %s",
    (collection) => {
      expect(() => assertRequestAllowed({ method: "POST", path: `/${collection}`, body: draft }, false)).toThrow(GuardError);
    },
  );

  it("refuses malformed paths", () => {
    for (const path of ["posts", "/posts/../settings", "/posts?status=publish", "/", ""]) {
      expect(() => assertRequestAllowed({ method: "GET", path }, false)).toThrow(GuardError);
    }
  });

  it("refuses every write in read-only mode but still allows reads", () => {
    expect(() => assertRequestAllowed({ method: "POST", path: "/posts", body: draft }, true)).toThrow(/WP_READ_ONLY/);
    expect(() => assertRequestAllowed({ method: "POST", path: "/media/88", body: { alt_text: "A" } }, true)).toThrow(/WP_READ_ONLY/);
    expect(() => assertRequestAllowed({ method: "GET", path: "/posts" }, true)).not.toThrow();
  });
});

describe("WpClient", () => {
  it("never calls fetch for a refused request", async () => {
    const { fetchImpl, calls } = fakeSite();
    const client = new WpClient(CONFIG, fetchImpl);
    await expect(client.request({ method: "DELETE", path: "/posts/42" })).rejects.toThrow(GuardError);
    await expect(client.post("/posts", { ...draft, status: "publish" })).rejects.toThrow(GuardError);
    await expect(client.post("/posts/42", { status: "draft" })).rejects.toThrow(GuardError);
    await expect(new WpClient({ ...CONFIG, readOnly: true }, fetchImpl).post("/posts", draft)).rejects.toThrow(GuardError);
    expect(calls).toHaveLength(0);
  });

  it("sends the Basic auth header and builds the REST URL", async () => {
    const { fetchImpl, calls } = fakeSite();
    const client = new WpClient(CONFIG, fetchImpl);
    await client.get("/posts", { search: "gears & chains", per_page: 5, page: undefined });
    expect(calls[0]!.url.href).toBe(`${SITE}/wp-json/wp/v2/posts?search=gears+%26+chains&per_page=5`);
    expect(calls[0]!.headers.Authorization).toBe(buildAuthHeader(CONFIG.username, CONFIG.appPassword));
    expect(calls[0]!.method).toBe("GET");
  });

  it("sends JSON on POST", async () => {
    const { fetchImpl, calls } = fakeSite();
    await new WpClient(CONFIG, fetchImpl).post("/posts", draft);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual(draft);
  });

  it("reads the pagination headers", async () => {
    const { fetchImpl } = fakeSite();
    const res = await new WpClient(CONFIG, fetchImpl).get<unknown[]>("/posts");
    expect(res.total).toBe(37);
    expect(res.totalPages).toBe(19);
    expect(res.data).toHaveLength(2);
  });

  it("walks every page of a collection and stops at the last one", async () => {
    const { fetchImpl, calls } = fakeSite();
    const walked = await new WpClient(CONFIG, fetchImpl).getPages<{ id: number }>("/media", { media_type: "image" });
    expect(walked.items.map((m) => m.id)).toEqual([88, 91, 93, 97, 99]);
    expect(walked).toMatchObject({ total: 5, pagesFetched: 2, complete: true });
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
  });

  it("stops at maxPages and reports the walk as incomplete", async () => {
    const { fetchImpl, calls } = fakeSite();
    const walked = await new WpClient(CONFIG, fetchImpl).getPages("/media", {}, { maxPages: 1 });
    expect(walked).toMatchObject({ pagesFetched: 1, complete: false });
    expect(walked.items).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("turns a WordPress error body into a WpApiError with status and code", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 403, json: fixture("error-forbidden") }));
    const error = await new WpClient(CONFIG, fetchImpl).get("/posts/1").catch((e) => e);
    expect(error).toBeInstanceOf(WpApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("rest_forbidden_context");
    expect(error.message).toContain("Sorry, you are not allowed to edit this post.");
  });

  it("explains a non-JSON response", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, text: "<!doctype html><title>Home</title>" }));
    await expect(new WpClient(CONFIG, fetchImpl).get("/posts")).rejects.toThrow(/non-JSON response/);
  });

  it("never puts credentials in error messages", async () => {
    const secretParts = [CONFIG.appPassword, CONFIG.username, buildAuthHeader(CONFIG.username, CONFIG.appPassword).slice(6)];
    const failing = [
      mockFetch(() => ({ status: 401, json: { code: "rest_not_logged_in", message: "You are not currently logged in." } })).fetchImpl,
      mockFetch(() => ({ status: 500, text: "oops" })).fetchImpl,
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const fetchImpl of failing) {
      const error = await new WpClient(CONFIG, fetchImpl).get("/posts").catch((e) => e);
      expect(error).toBeInstanceOf(WpApiError);
      for (const secret of secretParts) expect(String(error.message)).not.toContain(secret);
    }
  });
});
