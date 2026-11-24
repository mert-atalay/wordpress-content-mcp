/**
 * Audit checks. Each one is a pure function: same input, same result.
 * Nothing here talks to the network.
 *
 * The thresholds are common rules of thumb, not rules from any search engine.
 */

import type { ParsedContent } from "./html.js";

export type CheckStatus = "pass" | "warn" | "fail" | "not_available";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  /** The measured facts behind the status. */
  value: unknown;
  /** What was found on this page. */
  message: string;
  /** Why the check exists, in plain words. */
  explanation: string;
}

export interface AuditInput {
  /** Post title as plain text. */
  title: string;
  /** Hand-written excerpt. null means the site did not expose it to this user. */
  excerptRaw: string | null;
  /** The yoast_head_json object, or null when the site does not expose it. */
  yoast: Record<string, unknown> | null;
  parsed: ParsedContent;
}

export interface AuditOptions {
  /**
   * Most themes print the post title as the page H1, outside the content the REST API returns.
   * When true, the title counts as the one H1.
   */
  titleIsH1: boolean;
  /** Pages with fewer words than this are flagged as thin. */
  thinContentWords: number;
}

export const DEFAULT_AUDIT_OPTIONS: AuditOptions = { titleIsH1: true, thinContentWords: 300 };

export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const META_DESCRIPTION_MIN = 70;
export const META_DESCRIPTION_MAX = 160;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function checkTitleLength(title: string, yoast: Record<string, unknown> | null): CheckResult {
  const seoTitle = nonEmptyString(yoast?.title);
  const measured = seoTitle ?? title.trim();
  const source = seoTitle ? "yoast_seo_title" : "post_title";
  const length = [...measured].length;
  const explanation =
    `Search results usually cut titles off after about ${TITLE_MAX} characters, and very short titles say little. ` +
    `${TITLE_MIN} to ${TITLE_MAX} characters is a rule of thumb. ` +
    "I measure the Yoast SEO title when the site exposes it, otherwise the post title. The theme may add a site name that I cannot see.";
  const value = { title: measured, length, source };
  if (length === 0) {
    return { id: "title_length", status: "fail", value, message: "The title is empty.", explanation };
  }
  if (length < TITLE_MIN || length > TITLE_MAX) {
    const side = length < TITLE_MIN ? `shorter than ${TITLE_MIN}` : `longer than ${TITLE_MAX}`;
    return { id: "title_length", status: "warn", value, message: `The title is ${length} characters, ${side}.`, explanation };
  }
  return { id: "title_length", status: "pass", value, message: `The title is ${length} characters.`, explanation };
}

export function checkH1(parsed: ParsedContent, titleIsH1: boolean): CheckResult {
  const inContent = parsed.headings.filter((h) => h.level === 1);
  const effective = inContent.length + (titleIsH1 ? 1 : 0);
  const value = { h1_in_content: inContent.map((h) => h.text), title_counted_as_h1: titleIsH1, effective_h1_count: effective };
  const explanation =
    "A page should have one H1 that says what the page is about. " +
    "The REST API returns only the content area, and most themes print the post title as the H1 above it. " +
    "By default I count the title as the H1. Set title_is_h1 to false if the theme does not do that.";
  if (effective === 0) {
    return { id: "h1", status: "fail", value, message: "There is no H1 in the content, and the title is not counted as one.", explanation };
  }
  if (effective > 1) {
    const message = titleIsH1
      ? `The content has ${inContent.length} H1 heading(s) in addition to the title, so the page likely has ${effective} H1s.`
      : `The content has ${inContent.length} H1 headings.`;
    return { id: "h1", status: "warn", value, message, explanation };
  }
  const message = titleIsH1 ? "No H1 in the content. The title is counted as the single H1." : "The content has exactly one H1.";
  return { id: "h1", status: "pass", value, message, explanation };
}

export function checkHeadingOrder(parsed: ParsedContent, titleIsH1: boolean): CheckResult {
  const skips: { from: number; to: number; heading: string }[] = [];
  let previous = titleIsH1 ? 1 : (parsed.headings[0]?.level ?? 1);
  for (const heading of parsed.headings) {
    if (heading.level > previous + 1) {
      skips.push({ from: previous, to: heading.level, heading: heading.text });
    }
    previous = heading.level;
  }
  const explanation =
    "Headings should step down one level at a time, for example H2 then H3. " +
    "Jumping from H2 to H4 makes the outline harder to follow for screen reader users and for anything that reads the page structure.";
  const value = { outline: parsed.headings.map((h) => `H${h.level}`), skips };
  if (skips.length > 0) {
    const first = skips[0]!;
    return {
      id: "heading_order",
      status: "warn",
      value,
      message: `${skips.length} heading level skip(s). First: H${first.from} to H${first.to} at "${first.heading}".`,
      explanation,
    };
  }
  const message = parsed.headings.length === 0 ? "The content has no headings." : "Heading levels do not skip.";
  return { id: "heading_order", status: "pass", value, message, explanation };
}

export function checkImageAlt(parsed: ParsedContent): CheckResult {
  const missing = parsed.images.filter((img) => img.alt === null);
  const empty = parsed.images.filter((img) => img.alt !== null && img.alt.trim() === "");
  const value = {
    images: parsed.images.length,
    missing_alt_attribute: missing.map((img) => img.src),
    empty_alt: empty.map((img) => img.src),
  };
  const explanation =
    "Alt text describes an image to people who cannot see it and to search engines. " +
    'An empty alt="" is correct for a purely decorative image, so empty values need a human look. A missing attribute is always a gap.';
  if (parsed.images.length === 0) {
    return { id: "image_alt", status: "pass", value, message: "The content has no images.", explanation };
  }
  if (missing.length + empty.length > 0) {
    return {
      id: "image_alt",
      status: "warn",
      value,
      message: `${missing.length} image(s) have no alt attribute and ${empty.length} have an empty one, out of ${parsed.images.length}.`,
      explanation,
    };
  }
  return { id: "image_alt", status: "pass", value, message: `All ${parsed.images.length} image(s) have alt text.`, explanation };
}

export function checkLinks(parsed: ParsedContent): CheckResult {
  const count = (kind: string) => parsed.links.filter((link) => link.kind === kind).length;
  const value = { internal: count("internal"), external: count("external"), other: count("other") };
  const explanation =
    "Internal links help visitors and crawlers reach related pages. " +
    "I count links in the content area only, not menus or footers. Anchors, mailto and tel links are counted as other.";
  const summary = `${value.internal} internal, ${value.external} external, ${value.other} other link(s).`;
  if (value.internal === 0) {
    return { id: "links", status: "warn", value, message: `${summary} The content links to no other page on this site.`, explanation };
  }
  return { id: "links", status: "pass", value, message: summary, explanation };
}

export function checkWordCount(parsed: ParsedContent, thinContentWords: number): CheckResult {
  const value = { words: parsed.wordCount, threshold: thinContentWords };
  const explanation =
    `Pages with very little text often do not answer the question a visitor came with. ` +
    `Under ${thinContentWords} words is flagged as thin. This is a prompt to look, not a verdict. Some pages are short on purpose.`;
  if (parsed.wordCount < thinContentWords) {
    return { id: "word_count", status: "warn", value, message: `The content has ${parsed.wordCount} words, under ${thinContentWords}.`, explanation };
  }
  return { id: "word_count", status: "pass", value, message: `The content has ${parsed.wordCount} words.`, explanation };
}

export function checkExcerpt(excerptRaw: string | null): CheckResult {
  const explanation =
    "A hand-written excerpt is used by many themes on archive pages and can be used as a fallback description. " +
    "Without one, WordPress cuts the first words of the content. " +
    "I can only tell them apart when the account may read the raw excerpt.";
  if (excerptRaw === null) {
    return {
      id: "excerpt",
      status: "not_available",
      value: null,
      message: "The raw excerpt is not available to this account, so I cannot tell a written excerpt from an automatic one.",
      explanation,
    };
  }
  const length = [...excerptRaw.trim()].length;
  if (length === 0) {
    return { id: "excerpt", status: "warn", value: { length }, message: "No hand-written excerpt is set.", explanation };
  }
  return { id: "excerpt", status: "pass", value: { length }, message: `A hand-written excerpt is set (${length} characters).`, explanation };
}

export function checkMetaDescription(yoast: Record<string, unknown> | null): CheckResult {
  const explanation =
    "The meta description is often shown under the title in search results. " +
    `${META_DESCRIPTION_MIN} to ${META_DESCRIPTION_MAX} characters is a rule of thumb. ` +
    "WordPress core has no meta description field. I read it from yoast_head_json when the Yoast SEO plugin exposes it in the REST API.";
  if (yoast === null) {
    return {
      id: "meta_description",
      status: "not_available",
      value: null,
      message: "The site does not expose yoast_head_json, so the meta description cannot be read through the REST API.",
      explanation,
    };
  }
  const description = nonEmptyString(yoast.description);
  if (description === null) {
    return { id: "meta_description", status: "warn", value: { length: 0 }, message: "Yoast data is present but no meta description is set.", explanation };
  }
  const length = [...description].length;
  const value = { description, length };
  if (length < META_DESCRIPTION_MIN || length > META_DESCRIPTION_MAX) {
    const side = length < META_DESCRIPTION_MIN ? `shorter than ${META_DESCRIPTION_MIN}` : `longer than ${META_DESCRIPTION_MAX}`;
    return { id: "meta_description", status: "warn", value, message: `The meta description is ${length} characters, ${side}.`, explanation };
  }
  return { id: "meta_description", status: "pass", value, message: `The meta description is ${length} characters.`, explanation };
}

export function checkJsonLd(parsed: ParsedContent, yoast: Record<string, unknown> | null): CheckResult {
  const invalid = parsed.jsonLd.filter((block) => !block.valid).length;
  const contentTypes = parsed.jsonLd.flatMap((block) => block.types);
  const yoastSchema = yoast !== null && yoast.schema !== null && typeof yoast.schema === "object";
  const value = {
    blocks_in_content: parsed.jsonLd.length,
    invalid_blocks_in_content: invalid,
    types_in_content: contentTypes,
    yoast_schema_present: yoast === null ? null : yoastSchema,
  };
  const explanation =
    "JSON-LD structured data tells search engines what a page describes. " +
    "Themes and plugins usually print it in the page head, which the REST API does not return. " +
    "I can see JSON-LD inside the content, and the schema Yoast reports when it is exposed. I check that it parses, not that it is correct.";
  if (invalid > 0) {
    return { id: "json_ld", status: "fail", value, message: `${invalid} JSON-LD block(s) in the content are not valid JSON.`, explanation };
  }
  if (parsed.jsonLd.length > 0 || yoastSchema) {
    const where = [parsed.jsonLd.length > 0 ? "in the content" : null, yoastSchema ? "in the Yoast head data" : null]
      .filter(Boolean)
      .join(" and ");
    return { id: "json_ld", status: "pass", value, message: `JSON-LD is present ${where}.`, explanation };
  }
  if (yoast !== null) {
    return { id: "json_ld", status: "warn", value, message: "No JSON-LD in the content and none in the Yoast head data.", explanation };
  }
  return {
    id: "json_ld",
    status: "not_available",
    value,
    message: "No JSON-LD in the content. The page head is not visible through the REST API, so schema printed there cannot be checked.",
    explanation,
  };
}

export function auditContent(input: AuditInput, options: Partial<AuditOptions> = {}): CheckResult[] {
  const opts = { ...DEFAULT_AUDIT_OPTIONS, ...options };
  return [
    checkTitleLength(input.title, input.yoast),
    checkH1(input.parsed, opts.titleIsH1),
    checkHeadingOrder(input.parsed, opts.titleIsH1),
    checkImageAlt(input.parsed),
    checkLinks(input.parsed),
    checkWordCount(input.parsed, opts.thinContentWords),
    checkExcerpt(input.excerptRaw),
    checkMetaDescription(input.yoast),
    checkJsonLd(input.parsed, input.yoast),
  ];
}

export function countByStatus(checks: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, not_available: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}
