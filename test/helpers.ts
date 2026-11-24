import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Config } from "../src/config.js";
import type { FetchLike } from "../src/wp-client.js";

export const SITE = "https://tidewater-cycles.example";

export const CONFIG: Config = {
  baseUrl: SITE,
  username: "audit-bot",
  appPassword: "abcd EFGH 1234 ijkl MNOP 5678",
  readOnly: false,
};

export function fixture<T = any>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface Call {
  method: string;
  url: URL;
  /** Path under /wp-json/wp/v2 */
  path: string;
  headers: Record<string, string>;
  body: any;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A fetch stand-in that records every call and answers from a handler. No network. */
export function mockFetch(handler: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      path: url.pathname.replace(/^.*\/wp-json\/wp\/v2/, ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = handler(call);
    const body = reply.text ?? JSON.stringify(reply.json ?? null);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json", ...reply.headers },
    });
  };
  return { fetchImpl, calls };
}

const notFound: Reply = { status: 404, json: fixture("error-not-found") };

/**
 * Answers like the small invented site in test/fixtures.
 * `canEdit: false` makes context=edit fail the way WordPress does for a low-privilege account.
 */
export function fakeSite(options: { canEdit?: boolean } = {}) {
  const canEdit = options.canEdit ?? true;
  const pages = [fixture("page-good"), fixture("page-problems")];
  const mediaPages = [fixture<any[]>("media-page-1"), fixture<any[]>("media-page-2")];
  let nextId = 301;

  return mockFetch((call) => {
    const q = call.url.searchParams;
    if (call.method === "GET" && q.get("context") === "edit" && !canEdit) {
      return { status: 403, json: fixture("error-forbidden") };
    }
    if (call.method === "GET" && q.get("status") === "any" && !canEdit) {
      return { status: 400, json: { code: "rest_invalid_param", message: "Invalid parameter(s): status", data: { status: 400 } } };
    }

    if (call.method === "GET") {
      if (call.path === "/types") return { json: fixture("types") };
      if (call.path === "/taxonomies") return { json: fixture("taxonomies") };
      if (call.path === "/categories") return { json: fixture("categories"), headers: { "X-WP-Total": "3", "X-WP-TotalPages": "1" } };
      if (call.path === "/posts") {
        if (q.get("slug")) return { json: [] };
        return { json: fixture("posts-list"), headers: { "X-WP-Total": "37", "X-WP-TotalPages": "19" } };
      }
      if (call.path === "/pages") {
        const slug = q.get("slug");
        const list = slug ? pages.filter((p) => p.slug === slug) : pages;
        return { json: list, headers: { "X-WP-Total": String(list.length), "X-WP-TotalPages": "1" } };
      }
      const page = /^\/pages\/(\d+)$/.exec(call.path);
      if (page) {
        const found = pages.find((p) => p.id === Number(page[1]));
        return found ? { json: found } : notFound;
      }
      if (/^\/posts\/\d+$/.test(call.path)) return notFound;
      if (call.path === "/media") {
        const index = Number(q.get("page") ?? "1") - 1;
        return { json: mediaPages[index] ?? [], headers: { "X-WP-Total": "5", "X-WP-TotalPages": "2" } };
      }
      const media = /^\/media\/(\d+)$/.exec(call.path);
      if (media) {
        const found = mediaPages.flat().find((m) => m.id === Number(media[1]));
        return found ? { json: found } : notFound;
      }
    }

    if (call.method === "POST") {
      const media = /^\/media\/(\d+)$/.exec(call.path);
      if (media) {
        const found = mediaPages.flat().find((m) => m.id === Number(media[1]));
        return found ? { json: { ...found, alt_text: call.body.alt_text } } : notFound;
      }
      if (call.path === "/posts" || call.path === "/pages") {
        const created = fixture("created-draft");
        return {
          status: 201,
          json: {
            ...created,
            id: nextId++,
            type: call.path === "/pages" ? "page" : "post",
            status: call.body.status,
            title: { raw: call.body.title, rendered: call.body.title },
          },
        };
      }
    }
    return notFound;
  });
}
