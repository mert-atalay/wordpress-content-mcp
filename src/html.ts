/**
 * Turns the rendered HTML of a post or page into the plain facts the audit needs:
 * visible text, headings, links, images and JSON-LD blocks.
 */

import { parse, type HTMLElement, type Node } from "node-html-parser";

export interface Heading {
  level: number;
  text: string;
}

export type LinkKind = "internal" | "external" | "other";

export interface Link {
  href: string;
  text: string;
  kind: LinkKind;
}

export interface Image {
  src: string;
  /** null when the alt attribute is missing, "" when it is present but empty. */
  alt: string | null;
}

export interface JsonLdBlock {
  valid: boolean;
  types: string[];
}

export interface ParsedContent {
  text: string;
  wordCount: number;
  headings: Heading[];
  links: Link[];
  images: Image[];
  jsonLd: JsonLdBlock[];
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SKIPPED_TAGS = new Set(["script", "style", "noscript", "template"]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
  "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);

function collectText(node: Node, out: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    // Line breaks in the HTML source are plain whitespace. Only block elements start a new line.
    out.push(node.text.replace(/\s+/g, " "));
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const tag = ((node as HTMLElement).rawTagName ?? "").toLowerCase();
  if (SKIPPED_TAGS.has(tag)) return;
  const block = BLOCK_TAGS.has(tag);
  if (block) out.push("\n");
  for (const child of node.childNodes) collectText(child, out);
  if (block) out.push("\n");
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Visible text with one line per block element. Scripts and styles are left out. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  collectText(parse(html), out);
  return out
    .join("")
    .split("\n")
    .map(squash)
    .filter((line) => line !== "")
    .join("\n");
}

/** Decodes entities in a short rendered string such as title.rendered. */
export function plainText(html: string): string {
  return squash(htmlToText(html));
}

export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return words ? words.length : 0;
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function classifyLink(href: string, siteUrl: string): LinkKind {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return "other";
  let url: URL;
  try {
    url = new URL(trimmed, siteUrl);
  } catch {
    return "other";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "other";
  return stripWww(url.hostname) === stripWww(new URL(siteUrl).hostname) ? "internal" : "external";
}

function jsonLdTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdTypes);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record["@type"];
  const types = Array.isArray(own) ? own.map(String) : typeof own === "string" ? [own] : [];
  return [...types, ...jsonLdTypes(record["@graph"])];
}

export function parseContent(html: string, siteUrl: string): ParsedContent {
  const root = parse(html);
  const text = htmlToText(html);

  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6").map((el) => ({
    level: Number(el.rawTagName.slice(1)),
    text: squash(el.text),
  }));

  const links = root.querySelectorAll("a[href]").map((el) => {
    const href = el.getAttribute("href") ?? "";
    return { href, text: squash(el.text), kind: classifyLink(href, siteUrl) };
  });

  const images = root.querySelectorAll("img").map((el) => ({
    src: el.getAttribute("src") ?? "",
    alt: el.hasAttribute("alt") ? (el.getAttribute("alt") ?? "") : null,
  }));

  const jsonLd = root.querySelectorAll("script").flatMap((el): JsonLdBlock[] => {
    if ((el.getAttribute("type") ?? "").trim().toLowerCase() !== "application/ld+json") return [];
    try {
      return [{ valid: true, types: jsonLdTypes(JSON.parse(el.rawText)) }];
    } catch {
      return [{ valid: false, types: [] }];
    }
  });

  return { text, wordCount: countWords(text), headings, links, images, jsonLd };
}
