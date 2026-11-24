/**
 * WordPress operations behind the tools. Reads and the three narrow writes.
 * All requests go through WpClient, which enforces the write guard.
 */

import { auditContent, countByStatus, type AuditOptions, type CheckResult, type CheckStatus } from "./audit.js";
import { parseContent, plainText, type ParsedContent } from "./html.js";
import { WpApiError, type QueryValue, type WpClient } from "./wp-client.js";

interface Rendered {
  rendered?: string;
  raw?: string;
}

/** The parts of a WordPress post or page object that this server uses. */
export interface WpPost {
  id: number;
  slug: string;
  status: string;
  type: string;
  link: string;
  date?: string;
  modified?: string;
  title?: Rendered;
  content?: Rendered;
  excerpt?: Rendered;
  yoast_head_json?: Record<string, unknown> | null;
}

interface WpType {
  slug: string;
  name: string;
  rest_base: string;
}

interface WpTaxonomy {
  slug: string;
  name: string;
  rest_base: string;
  types?: string[];
  hierarchical?: boolean;
}

export interface WpMedia {
  id: number;
  alt_text?: string;
  source_url?: string;
  link?: string;
  media_type?: string;
  title?: Rendered;
  post?: number | null;
}

const typeCache = new WeakMap<WpClient, Promise<Record<string, WpType>>>();

/** Maps a post type slug ("post", "page", "product") or REST base ("posts") to its REST base. */
export async function resolveRestBase(client: WpClient, type: string): Promise<string> {
  let types = typeCache.get(client);
  if (!types) {
    types = client.get<Record<string, WpType>>("/types").then((res) => res.data);
    typeCache.set(client, types);
    types.catch(() => typeCache.delete(client));
  }
  const all = Object.values(await types);
  const wanted = type.trim().toLowerCase();
  const match = all.find((t) => t.slug === wanted) ?? all.find((t) => t.rest_base === wanted);
  if (!match) {
    const known = all.map((t) => t.slug).join(", ");
    throw new Error(`Unknown content type "${type}". Types on this site: ${known}`);
  }
  return match.rest_base;
}

function isPermissionError(error: unknown): boolean {
  return error instanceof WpApiError && [400, 401, 403].includes(error.status);
}

/**
 * Asks for context=edit first, which includes raw fields such as the hand-written excerpt.
 * If the account may not do that, falls back to the public view.
 */
async function getWithEditFallback<T>(
  client: WpClient,
  path: string,
  editQuery: Record<string, QueryValue>,
  viewQuery: Record<string, QueryValue>,
): Promise<T> {
  try {
    return (await client.get<T>(path, { ...editQuery, context: "edit" })).data;
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    return (await client.get<T>(path, viewQuery)).data;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListContentArgs {
  type?: string;
  search?: string;
  status?: string;
  page?: number;
  per_page?: number;
}

export async function listContent(client: WpClient, args: ListContentArgs) {
  const base = await resolveRestBase(client, args.type ?? "post");
  const page = args.page ?? 1;
  const perPage = args.per_page ?? 20;
  const res = await client.get<WpPost[]>(`/${base}`, {
    search: args.search,
    status: args.status ?? "publish",
    page,
    per_page: perPage,
    orderby: args.search ? undefined : "modified",
    order: args.search ? undefined : "desc",
    _fields: "id,slug,status,type,link,title,date,modified",
  });
  return {
    items: res.data.map((post) => ({
      id: post.id,
      type: post.type,
      status: post.status,
      title: plainText(post.title?.rendered ?? ""),
      slug: post.slug,
      link: post.link,
      modified: post.modified,
    })),
    page,
    per_page: perPage,
    total: res.total ?? null,
    total_pages: res.totalPages ?? null,
  };
}

export interface ContentRef {
  id?: number;
  /** Full URL on this site, or a bare slug. */
  url_or_slug?: string;
  type?: string;
}

function slugFromUrlOrSlug(client: WpClient, value: string): { slug: string; url: string | null } {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    const slug = trimmed.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
    if (slug === "") throw new Error("url_or_slug is empty.");
    return { slug, url: null };
  }
  const url = new URL(trimmed);
  const site = new URL(client.baseUrl);
  if (url.hostname.replace(/^www\./, "") !== site.hostname.replace(/^www\./, "")) {
    throw new Error(`That URL is not on the configured site (${site.hostname}).`);
  }
  const slug = url.pathname.split("/").filter(Boolean).pop();
  if (!slug) {
    throw new Error("I cannot resolve the home page from its URL. Use list_content to find its id.");
  }
  return { slug: decodeURIComponent(slug), url: trimmed };
}

function sameUrl(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Finds one post or page by id, URL or slug. Without a type it tries pages, then posts. */
export async function fetchContent(client: WpClient, ref: ContentRef): Promise<WpPost> {
  if (ref.id === undefined && !ref.url_or_slug) {
    throw new Error("Give either id or url_or_slug.");
  }
  const types = ref.type ? [ref.type] : ["page", "post"];

  for (const type of types) {
    const base = await resolveRestBase(client, type);
    if (ref.id !== undefined) {
      try {
        return await getWithEditFallback<WpPost>(client, `/${base}/${ref.id}`, {}, {});
      } catch (error) {
        if (error instanceof WpApiError && error.status === 404) continue;
        throw error;
      }
    }
    const { slug, url } = slugFromUrlOrSlug(client, ref.url_or_slug as string);
    const found = await getWithEditFallback<WpPost[]>(client, `/${base}`, { slug, status: "any" }, { slug });
    const match = (url && found.find((post) => sameUrl(post.link, url))) || found[0];
    if (match) return match;
  }
  const what = ref.id !== undefined ? `id ${ref.id}` : `"${ref.url_or_slug}"`;
  throw new Error(`Nothing found for ${what} in: ${types.join(", ")}. For a custom post type, pass its type.`);
}

function yoastOf(post: WpPost): Record<string, unknown> | null {
  const yoast = post.yoast_head_json;
  return yoast !== null && typeof yoast === "object" ? yoast : null;
}

function parsePost(client: WpClient, post: WpPost): ParsedContent {
  return parseContent(post.content?.rendered ?? "", client.baseUrl);
}

function titleOf(post: WpPost): string {
  return post.title?.raw ?? plainText(post.title?.rendered ?? "");
}

export async function getContent(client: WpClient, ref: ContentRef & { max_chars?: number }) {
  const post = await fetchContent(client, ref);
  const parsed = parsePost(client, post);
  const maxChars = ref.max_chars ?? 20_000;
  const yoast = yoastOf(post);
  return {
    id: post.id,
    type: post.type,
    status: post.status,
    title: titleOf(post),
    slug: post.slug,
    link: post.link,
    modified: post.modified ?? null,
    excerpt: post.excerpt?.raw ?? null,
    meta_description: yoast ? (typeof yoast.description === "string" ? yoast.description : "") : "not available",
    word_count: parsed.wordCount,
    text: parsed.text.slice(0, maxChars),
    text_truncated: parsed.text.length > maxChars,
    headings: parsed.headings,
    links: parsed.links,
    images: parsed.images,
  };
}

export interface MissingAltArgs {
  max_pages?: number;
  per_page?: number;
}

export async function listMediaMissingAlt(client: WpClient, args: MissingAltArgs) {
  const walked = await client.getPages<WpMedia>(
    "/media",
    { media_type: "image", _fields: "id,alt_text,source_url,link,title,post" },
    { perPage: args.per_page ?? 100, maxPages: args.max_pages ?? 3 },
  );
  const missing = walked.items.filter((item) => (item.alt_text ?? "").trim() === "");
  return {
    total_images: walked.total ?? null,
    scanned: walked.items.length,
    complete: walked.complete,
    missing_count: missing.length,
    missing: missing.map((item) => ({
      id: item.id,
      title: plainText(item.title?.rendered ?? ""),
      source_url: item.source_url ?? null,
      attached_to_post: item.post ?? null,
    })),
    note: walked.complete
      ? "Every image in the media library was scanned."
      : "The scan stopped at max_pages. Raise max_pages to scan more of the library.",
  };
}

export interface TaxonomyArgs {
  taxonomy?: string;
  search?: string;
  page?: number;
  per_page?: number;
}

export async function listTaxonomies(client: WpClient, args: TaxonomyArgs) {
  const taxonomies = Object.values((await client.get<Record<string, WpTaxonomy>>("/taxonomies")).data);
  if (!args.taxonomy) {
    return {
      taxonomies: taxonomies.map((tax) => ({
        slug: tax.slug,
        name: tax.name,
        rest_base: tax.rest_base,
        content_types: tax.types ?? [],
        hierarchical: tax.hierarchical ?? false,
      })),
    };
  }
  const wanted = args.taxonomy.trim().toLowerCase();
  const tax = taxonomies.find((t) => t.slug === wanted || t.rest_base === wanted);
  if (!tax) {
    throw new Error(`Unknown taxonomy "${args.taxonomy}". Taxonomies on this site: ${taxonomies.map((t) => t.slug).join(", ")}`);
  }
  const page = args.page ?? 1;
  const perPage = args.per_page ?? 50;
  const res = await client.get<{ id: number; name: string; slug: string; count: number; parent?: number; link: string }[]>(
    `/${tax.rest_base}`,
    { search: args.search, page, per_page: perPage, _fields: "id,name,slug,count,parent,link" },
  );
  return {
    taxonomy: tax.slug,
    terms: res.data,
    page,
    per_page: perPage,
    total: res.total ?? null,
    total_pages: res.totalPages ?? null,
  };
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

export interface PageAudit {
  id: number;
  type: string;
  status: string;
  title: string;
  link: string;
  summary: Record<CheckStatus, number>;
  checks: CheckResult[];
}

export function auditPost(client: WpClient, post: WpPost, options: Partial<AuditOptions> = {}): PageAudit {
  const checks = auditContent(
    {
      title: titleOf(post),
      excerptRaw: post.excerpt?.raw ?? null,
      yoast: yoastOf(post),
      parsed: parsePost(client, post),
    },
    options,
  );
  return {
    id: post.id,
    type: post.type,
    status: post.status,
    title: titleOf(post),
    link: post.link,
    summary: countByStatus(checks),
    checks,
  };
}

export async function auditPage(client: WpClient, ref: ContentRef, options: Partial<AuditOptions> = {}) {
  return auditPost(client, await fetchContent(client, ref), options);
}

export const AUDIT_SITE_MAX_SAMPLE = 25;

export interface AuditSiteArgs {
  type?: string;
  sample_size?: number;
}

/** Audits the most recently modified published items of one type. One request, at most 25 items. */
export async function auditSite(client: WpClient, args: AuditSiteArgs, options: Partial<AuditOptions> = {}) {
  const type = args.type ?? "page";
  const base = await resolveRestBase(client, type);
  const sample = Math.min(Math.max(args.sample_size ?? 10, 1), AUDIT_SITE_MAX_SAMPLE);
  const query = { status: "publish", per_page: sample, page: 1, orderby: "modified", order: "desc" };

  let res;
  try {
    res = await client.get<WpPost[]>(`/${base}`, { ...query, context: "edit" });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    res = await client.get<WpPost[]>(`/${base}`, query);
  }

  const audits = res.data.map((post) => auditPost(client, post, options));
  const rows = audits.map((audit) => ({
    id: audit.id,
    title: audit.title,
    link: audit.link,
    ...audit.summary,
    issues: audit.checks.filter((c) => c.status === "warn" || c.status === "fail").map((c) => c.id),
  }));

  const byCheck: Record<string, Record<CheckStatus, number>> = {};
  const explanations: Record<string, string> = {};
  for (const audit of audits) {
    for (const check of audit.checks) {
      const counts = (byCheck[check.id] ??= { pass: 0, warn: 0, fail: 0, not_available: 0 });
      counts[check.status] += 1;
      explanations[check.id] = check.explanation;
    }
  }

  return {
    type,
    sampled: audits.length,
    total_published: res.total ?? null,
    sample_rule: `The ${sample} most recently modified published items. This is a sample, not a full crawl.`,
    table: summaryTable(rows),
    rows,
    by_check: byCheck,
    explanations,
  };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

export function summaryTable(
  rows: { id: number; title: string; pass: number; warn: number; fail: number; not_available: number; issues: string[] }[],
): string {
  const lines = ["| ID | Title | Pass | Warn | Fail | N/A | Issues |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${cell(row.title)} | ${row.pass} | ${row.warn} | ${row.fail} | ${row.not_available} | ${row.issues.join(", ") || "none"} |`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Writes. There are three, and none of them can publish or delete.
// ---------------------------------------------------------------------------

function editUrl(client: WpClient, id: number): string {
  return `${client.baseUrl}/wp-admin/post.php?post=${id}&action=edit`;
}

function draftBody(fields: { title: string; content: string; excerpt?: string; slug?: string }, status: "draft" | "pending") {
  const body: Record<string, unknown> = { title: fields.title, content: fields.content, status };
  if (fields.excerpt !== undefined) body.excerpt = fields.excerpt;
  if (fields.slug !== undefined) body.slug = fields.slug;
  return body;
}

export interface CreateDraftArgs {
  type?: string;
  title: string;
  content: string;
  excerpt?: string;
  slug?: string;
}

export async function createDraft(client: WpClient, args: CreateDraftArgs) {
  const base = await resolveRestBase(client, args.type ?? "post");
  const created = (await client.post<WpPost>(`/${base}`, draftBody(args, "draft"))).data;
  return {
    id: created.id,
    type: created.type,
    status: created.status,
    edit_url: editUrl(client, created.id),
    note: "Saved as a draft. It is not public. A person has to review and publish it in WordPress.",
  };
}

export interface ProposeRevisionArgs {
  id: number;
  type?: string;
  title?: string;
  content?: string;
  excerpt?: string;
  mode?: "draft_copy" | "pending_copy";
}

/**
 * Saves a proposed change to an existing item as a NEW item with status draft or pending.
 * The original is read, never written.
 */
export async function proposeRevision(client: WpClient, args: ProposeRevisionArgs) {
  const changed = (["title", "content", "excerpt"] as const).filter((field) => args[field] !== undefined);
  if (changed.length === 0) {
    throw new Error("Give at least one of title, content or excerpt to propose.");
  }
  const original = await fetchContent(client, { id: args.id, type: args.type });
  const originalContent = original.content?.raw ?? original.content?.rendered;
  if (args.content === undefined && originalContent === undefined) {
    throw new Error("The original content could not be read, so a copy cannot be made. Pass the full proposed content.");
  }
  const base = await resolveRestBase(client, original.type);
  const status = args.mode === "pending_copy" ? "pending" : "draft";
  const body = draftBody(
    {
      title: `[Proposed revision of #${original.id}] ${args.title ?? titleOf(original)}`,
      content: args.content ?? (originalContent as string),
      excerpt: args.excerpt ?? original.excerpt?.raw,
    },
    status,
  );
  const created = (await client.post<WpPost>(`/${base}`, body)).data;
  return {
    original: { id: original.id, status: original.status, link: original.link, modified: original.modified ?? null },
    proposal: { id: created.id, status: created.status, edit_url: editUrl(client, created.id) },
    changed_fields: changed,
    note:
      "The original was not changed. The proposal is a separate copy. " +
      "A person has to compare it, copy the change into the original in WordPress, and remove the copy.",
  };
}

export async function updateMediaAltText(client: WpClient, args: { id: number; alt_text: string }) {
  const before = (await client.get<WpMedia>(`/media/${args.id}`, { _fields: "id,alt_text,source_url,media_type" })).data;
  const after = (await client.post<WpMedia>(`/media/${args.id}`, { alt_text: args.alt_text })).data;
  return {
    id: before.id,
    source_url: before.source_url ?? null,
    previous_alt_text: before.alt_text ?? "",
    alt_text: after.alt_text ?? args.alt_text,
    note: "This was a direct write to the media library. Images already placed in posts keep the alt text stored in the post content.",
  };
}
