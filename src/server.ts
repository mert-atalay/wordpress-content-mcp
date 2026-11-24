/**
 * Builds the MCP server and registers the tools.
 * Write tools are only registered when WP_READ_ONLY is not set.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import {
  AUDIT_SITE_MAX_SAMPLE,
  auditPage,
  auditSite,
  createDraft,
  getContent,
  listContent,
  listMediaMissingAlt,
  listTaxonomies,
  proposeRevision,
  updateMediaAltText,
} from "./content.js";
import { WpClient, type FetchLike } from "./wp-client.js";

export const SERVER_NAME = "wordpress-content-mcp";
export const SERVER_VERSION = "0.1.0";

export const READ_TOOLS = ["list_content", "get_content", "list_media_missing_alt", "list_taxonomies", "audit_page", "audit_site"];
export const WRITE_TOOLS = ["create_draft", "propose_revision", "update_media_alt_text"];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a tool body and turns the result or the error into MCP tool output. */
async function run(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await work();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const typeParam = (fallback: string) =>
  z.string().min(1).optional().describe(`Content type slug such as "post", "page" or a custom post type. Default: ${fallback}.`);

const refParams = {
  id: z.number().int().positive().optional().describe("Numeric WordPress id."),
  url_or_slug: z.string().min(1).optional().describe("Full URL on the configured site, or a slug. Used when id is not given."),
  type: z.string().min(1).optional().describe('Content type slug. Without it, "page" is tried first, then "post".'),
};

const auditParams = {
  title_is_h1: z
    .boolean()
    .optional()
    .describe("Whether the theme prints the post title as the page H1. Default true, which is what most themes do."),
  thin_content_words: z.number().int().positive().optional().describe("Word count under which content is flagged as thin. Default 300."),
};

function auditOptions(args: { title_is_h1?: boolean; thin_content_words?: number }) {
  return {
    ...(args.title_is_h1 === undefined ? {} : { titleIsH1: args.title_is_h1 }),
    ...(args.thin_content_words === undefined ? {} : { thinContentWords: args.thin_content_words }),
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(config: Config, fetchImpl?: FetchLike): McpServer {
  const client = new WpClient(config, fetchImpl);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "list_content",
    {
      title: "List content",
      description: "List posts, pages or items of a custom post type, with search, status filter and pagination. Read only.",
      inputSchema: {
        type: typeParam("post"),
        search: z.string().optional().describe("Search term."),
        status: z
          .enum(["publish", "draft", "pending", "future", "private", "any"])
          .optional()
          .describe("Status filter. Default publish. Other values need an account that may see them."),
        page: z.number().int().positive().optional().describe("Page number, starting at 1."),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1 to 100. Default 20."),
      },
      annotations: READ,
    },
    (args) => run(() => listContent(client, args)),
  );

  server.registerTool(
    "get_content",
    {
      title: "Get content",
      description:
        "Get one post or page by id, URL or slug. Returns title, slug, status, modified date, rendered text, " +
        "heading outline, links and images with their alt text. Read only.",
      inputSchema: {
        ...refParams,
        max_chars: z.number().int().positive().optional().describe("Cut the text after this many characters. Default 20000."),
      },
      annotations: READ,
    },
    (args) => run(() => getContent(client, args)),
  );

  server.registerTool(
    "list_media_missing_alt",
    {
      title: "List images without alt text",
      description: "Scan the media library for images whose alt text is empty. The scan is bounded by max_pages. Read only.",
      inputSchema: {
        max_pages: z.number().int().min(1).max(20).optional().describe("How many pages of the library to scan. Default 3."),
        per_page: z.number().int().min(1).max(100).optional().describe("Images per page, 1 to 100. Default 100."),
      },
      annotations: READ,
    },
    (args) => run(() => listMediaMissingAlt(client, args)),
  );

  server.registerTool(
    "list_taxonomies",
    {
      title: "List taxonomies and terms",
      description:
        "Without arguments, list the taxonomies on the site (categories, tags, custom). " +
        "With a taxonomy, list its terms and how many items use each. Read only.",
      inputSchema: {
        taxonomy: z.string().min(1).optional().describe('Taxonomy slug such as "category" or "post_tag".'),
        search: z.string().optional().describe("Search within the terms."),
        page: z.number().int().positive().optional(),
        per_page: z.number().int().min(1).max(100).optional().describe("Terms per page. Default 50."),
      },
      annotations: READ,
    },
    (args) => run(() => listTaxonomies(client, args)),
  );

  server.registerTool(
    "audit_page",
    {
      title: "Audit one page",
      description:
        "Run on-page checks on one post or page: title length, H1, heading order, image alt text, internal and external links, " +
        "word count, excerpt, meta description (from Yoast when exposed) and JSON-LD. Each check comes with a plain explanation. Read only.",
      inputSchema: { ...refParams, ...auditParams },
      annotations: READ,
    },
    (args) => run(() => auditPage(client, args, auditOptions(args))),
  );

  server.registerTool(
    "audit_site",
    {
      title: "Audit a sample of pages",
      description:
        `Run the same checks on a bounded sample: the most recently modified published items of one type, at most ${AUDIT_SITE_MAX_SAMPLE}. ` +
        "Returns a summary table and counts per check. It is a sample, not a crawl. Read only.",
      inputSchema: {
        type: typeParam("page"),
        sample_size: z.number().int().min(1).max(AUDIT_SITE_MAX_SAMPLE).optional().describe("How many items to audit. Default 10."),
        ...auditParams,
      },
      annotations: READ,
    },
    (args) => run(() => auditSite(client, args, auditOptions(args))),
  );

  if (config.readOnly) return server;

  server.registerTool(
    "create_draft",
    {
      title: "Create a draft",
      description:
        "WRITE. Create a new post or page. It is always saved with status draft and is not public. " +
        "This server cannot publish. A person publishes in WordPress.",
      inputSchema: {
        type: typeParam("post"),
        title: z.string().min(1),
        content: z.string().describe("Body as HTML or block markup."),
        excerpt: z.string().optional(),
        slug: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => createDraft(client, args)),
  );

  server.registerTool(
    "propose_revision",
    {
      title: "Propose a revision",
      description:
        "WRITE. Propose a change to an existing post or page. The proposal is saved as a NEW separate copy with status draft " +
        "(or pending review). The original is never changed and nothing is published. A person applies the change in WordPress.",
      inputSchema: {
        id: z.number().int().positive().describe("Id of the existing post or page."),
        type: z.string().min(1).optional().describe('Content type slug. Without it, "page" is tried first, then "post".'),
        title: z.string().min(1).optional().describe("Proposed title. Omit to keep the current one."),
        content: z.string().optional().describe("Proposed full body as HTML or block markup. Omit to keep the current one."),
        excerpt: z.string().optional().describe("Proposed excerpt. Omit to keep the current one."),
        mode: z
          .enum(["draft_copy", "pending_copy"])
          .optional()
          .describe("draft_copy saves the copy as a draft (default). pending_copy saves it as pending review."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => proposeRevision(client, args)),
  );

  server.registerTool(
    "update_media_alt_text",
    {
      title: "Update image alt text (direct write)",
      description:
        "DIRECT WRITE. Set the alt text of one media library item. This is the only tool that changes existing data, " +
        "and it replaces the current alt text. It is not available when WP_READ_ONLY=true.",
      inputSchema: {
        id: z.number().int().positive().describe("Media item id."),
        alt_text: z.string().max(500).describe("The new alt text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => run(() => updateMediaAltText(client, args)),
  );

  return server;
}
