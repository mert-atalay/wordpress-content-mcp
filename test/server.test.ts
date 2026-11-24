import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer, READ_TOOLS, WRITE_TOOLS } from "../src/server.js";
import { CONFIG, fakeSite, SITE } from "./helpers.js";

/** Connects a real MCP client to the server in memory, with WordPress replaced by the fake site. */
async function connect(options: { readOnly?: boolean; canEdit?: boolean } = {}) {
  const site = fakeSite({ canEdit: options.canEdit });
  const server = createServer({ ...CONFIG, readOnly: options.readOnly ?? false }, site.fetchImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
  };
  const writes = () => site.calls.filter((c) => c.method !== "GET");
  return { client, call, calls: site.calls, writes };
}

describe("tool list", () => {
  it("exposes the read, audit and write tools, and no publish or delete tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(names.filter((n) => /delete|publish|trash|remove/.test(n))).toEqual([]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(READ_TOOLS.includes(tool.name));
    }
  });

  it("registers no write tools when read-only", async () => {
    const { client, call, calls } = await connect({ readOnly: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    const result = await call("update_media_alt_text", { id: 91, alt_text: "A" });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("read tools", () => {
  it("list_content lists with pagination and passes search and status through", async () => {
    const { call, calls } = await connect();
    const { data } = await call("list_content", { type: "post", search: "gears", status: "any", page: 2, per_page: 2 });
    expect(data).toMatchObject({ page: 2, per_page: 2, total: 37, total_pages: 19 });
    expect(data.items[1]).toEqual({
      id: 118,
      type: "post",
      status: "publish",
      title: "Why Your Gears Skip – and What to Do",
      slug: "why-your-gears-skip",
      link: `${SITE}/why-your-gears-skip/`,
      modified: "2026-03-22T10:05:00",
    });
    const query = calls.at(-1)!.url.searchParams;
    expect(calls.at(-1)!.path).toBe("/posts");
    expect([query.get("search"), query.get("status"), query.get("page"), query.get("per_page")]).toEqual(["gears", "any", "2", "2"]);
  });

  it("list_content resolves a custom post type to its REST base and rejects unknown types", async () => {
    const { call, calls } = await connect();
    await call("list_content", { type: "workshop" });
    expect(calls.at(-1)!.path).toBe("/workshops");
    const bad = await call("list_content", { type: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("post, page, attachment, workshop");
  });

  it("get_content finds a page by id", async () => {
    const { call } = await connect();
    const { data } = await call("get_content", { id: 42 });
    expect(data).toMatchObject({
      id: 42,
      type: "page",
      status: "publish",
      title: "Spring Bike Service Checklist for Commuters",
      slug: "spring-service-checklist",
      modified: "2026-03-18T14:02:11",
      text_truncated: false,
    });
    expect(data.text).toContain("Rubber dries out when it sits.");
    expect(data.headings[0]).toEqual({ level: 2, text: "Start with the tyres" });
    expect(data.links).toHaveLength(3);
    expect(data.images[0].alt).toContain("Blue commuter bike");
    expect(data.meta_description).toContain("one hour checklist");
  });

  it("get_content finds a page by URL or slug, and truncates text on request", async () => {
    const { call } = await connect();
    const byUrl = await call("get_content", { url_or_slug: `${SITE}/guides/spring-service-checklist/`, max_chars: 50 });
    expect(byUrl.data.id).toBe(42);
    expect(byUrl.data.text).toHaveLength(50);
    expect(byUrl.data.text_truncated).toBe(true);
    const bySlug = await call("get_content", { url_or_slug: "hours" });
    expect(bySlug.data).toMatchObject({ id: 57, title: "Hours & Location", meta_description: "not available" });
  });

  it("get_content refuses a URL on another site and reports a miss", async () => {
    const { call } = await connect();
    const other = await call("get_content", { url_or_slug: "https://elsewhere.example.org/page/" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("not on the configured site");
    const miss = await call("get_content", { id: 999 });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("Nothing found for id 999");
  });

  it("get_content falls back to the public view when the account cannot use context=edit", async () => {
    const { call } = await connect({ canEdit: false });
    const byId = await call("get_content", { id: 42 });
    expect(byId.data.id).toBe(42);
    const bySlug = await call("get_content", { url_or_slug: "hours" });
    expect(bySlug.data.id).toBe(57);
  });

  it("list_media_missing_alt scans all pages and returns only images without alt text", async () => {
    const { call } = await connect();
    const { data } = await call("list_media_missing_alt");
    expect(data).toMatchObject({ total_images: 5, scanned: 5, complete: true, missing_count: 3 });
    expect(data.missing.map((m: { id: number }) => m.id)).toEqual([91, 93, 97]);
    const bounded = await call("list_media_missing_alt", { max_pages: 1 });
    expect(bounded.data).toMatchObject({ scanned: 3, complete: false, missing_count: 2 });
  });

  it("list_taxonomies lists taxonomies, then terms of one", async () => {
    const { call } = await connect();
    const all = await call("list_taxonomies");
    expect(all.data.taxonomies.map((t: { slug: string }) => t.slug)).toEqual(["category", "post_tag"]);
    const terms = await call("list_taxonomies", { taxonomy: "category" });
    expect(terms.data).toMatchObject({ taxonomy: "category", total: 3 });
    expect(terms.data.terms[1]).toMatchObject({ name: "Repair guides", count: 11 });
  });
});

describe("audit tools", () => {
  it("audit_page returns each check with status, message and explanation", async () => {
    const { call } = await connect();
    const { data } = await call("audit_page", { id: 57 });
    expect(data.summary).toEqual({ pass: 0, warn: 6, fail: 0, not_available: 3 });
    expect(data.checks).toHaveLength(9);
    expect(data.checks.find((c: { id: string }) => c.id === "heading_order").message).toContain("H2 to H4");
    const good = await call("audit_page", { url_or_slug: "spring-service-checklist" });
    expect(good.data.summary).toEqual({ pass: 9, warn: 0, fail: 0, not_available: 0 });
  });

  it("audit_page honours title_is_h1 and thin_content_words", async () => {
    const { call } = await connect();
    const { data } = await call("audit_page", { id: 57, title_is_h1: false, thin_content_words: 10 });
    const status = (id: string) => data.checks.find((c: { id: string }) => c.id === id).status;
    expect(status("h1")).toBe("pass");
    expect(status("word_count")).toBe("pass");
  });

  it("audit_site audits a bounded sample and returns a summary table", async () => {
    const { call, calls } = await connect();
    const { data } = await call("audit_site", { type: "page", sample_size: 5 });
    expect(data.sampled).toBe(2);
    expect(data.table.split("\n")).toEqual([
      "| ID | Title | Pass | Warn | Fail | N/A | Issues |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 42 | Spring Bike Service Checklist for Commuters | 9 | 0 | 0 | 0 | none |",
      "| 57 | Hours & Location | 0 | 6 | 0 | 3 | title_length, h1, heading_order, image_alt, links, word_count |",
    ]);
    expect(data.by_check.image_alt).toEqual({ pass: 1, warn: 1, fail: 0, not_available: 0 });
    expect(Object.keys(data.explanations)).toHaveLength(9);
    const listCalls = calls.filter((c) => c.path === "/pages");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.url.searchParams.get("per_page")).toBe("5");
  });

  it("audit_site rejects a sample above the limit", async () => {
    const { call, calls } = await connect();
    const result = await call("audit_site", { sample_size: 500 });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("write tools", () => {
  it("create_draft always sends status draft", async () => {
    const { call, writes } = await connect();
    const { data } = await call("create_draft", { type: "page", title: "Winter storage tips", content: "<p>Body</p>", excerpt: "Short" });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: "/pages",
      body: { title: "Winter storage tips", content: "<p>Body</p>", excerpt: "Short", status: "draft" },
    });
    expect(data).toMatchObject({ id: 301, status: "draft", edit_url: `${SITE}/wp-admin/post.php?post=301&action=edit` });
  });

  it("create_draft has no status argument, so a caller cannot ask for publish", async () => {
    const { client, call, writes } = await connect();
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "create_draft")!.inputSchema;
    expect(Object.keys(schema.properties ?? {})).not.toContain("status");
    await call("create_draft", { title: "T", content: "C", status: "publish" });
    for (const write of writes()) expect(write.body.status).toBe("draft");
  });

  it("propose_revision creates a new draft copy and never writes to the original", async () => {
    const { call, writes } = await connect();
    const { data } = await call("propose_revision", { id: 42, title: "Spring Service Checklist: Tyres, Brakes, Chain" });
    expect(writes()).toHaveLength(1);
    const write = writes()[0]!;
    expect(write.path).toBe("/pages");
    expect(write.body.status).toBe("draft");
    expect(write.body.title).toBe("[Proposed revision of #42] Spring Service Checklist: Tyres, Brakes, Chain");
    expect(write.body.content).toContain("wp:paragraph");
    expect(write.body.excerpt).toContain("An hour of checks");
    expect(data.original).toMatchObject({ id: 42, status: "publish" });
    expect(data.proposal).toMatchObject({ id: 301, status: "draft" });
    expect(data.changed_fields).toEqual(["title"]);
  });

  it("propose_revision can save the copy as pending, and nothing else", async () => {
    const { call, writes } = await connect();
    const { data } = await call("propose_revision", { id: 57, content: "<p>New hours</p>", mode: "pending_copy" });
    expect(writes().map((w) => [w.path, w.body.status])).toEqual([["/pages", "pending"]]);
    expect(data.proposal.status).toBe("pending");
    const bad = await call("propose_revision", { id: 57, content: "<p>x</p>", mode: "publish" });
    expect(bad.isError).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it("propose_revision needs something to propose", async () => {
    const { call, writes } = await connect();
    const result = await call("propose_revision", { id: 42 });
    expect(result.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("update_media_alt_text writes only alt_text and reports the previous value", async () => {
    const { call, writes } = await connect();
    const { data } = await call("update_media_alt_text", { id: 91, alt_text: "Mechanic fitting a new chain" });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/media/91", body: { alt_text: "Mechanic fitting a new chain" } });
    expect(Object.keys(writes()[0]!.body)).toEqual(["alt_text"]);
    expect(data).toMatchObject({ id: 91, previous_alt_text: "", alt_text: "Mechanic fitting a new chain" });
  });

  it("no tool ever sends DELETE, PUT, PATCH or a status other than draft or pending", async () => {
    const { call, calls } = await connect();
    await call("create_draft", { title: "A", content: "B" });
    await call("propose_revision", { id: 42, content: "<p>C</p>" });
    await call("propose_revision", { id: 57, excerpt: "D", mode: "pending_copy" });
    await call("update_media_alt_text", { id: 97, alt_text: "Shop front" });
    await call("audit_site", {});
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["GET", "POST"]));
    for (const c of calls.filter((x) => x.method === "POST" && !x.path.startsWith("/media/"))) {
      expect(["draft", "pending"]).toContain(c.body.status);
      expect(c.path).toMatch(/^\/(posts|pages)$/);
    }
  });
});
