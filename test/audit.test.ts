import { describe, expect, it } from "vitest";

import {
  auditContent,
  checkExcerpt,
  checkH1,
  checkHeadingOrder,
  checkImageAlt,
  checkJsonLd,
  checkLinks,
  checkMetaDescription,
  checkTitleLength,
  checkWordCount,
  countByStatus,
} from "../src/audit.js";
import { parseContent, plainText } from "../src/html.js";
import { fixture, SITE } from "./helpers.js";

const parse = (html: string) => parseContent(html, SITE);
const words = (n: number) => `<p>${Array.from({ length: n }, (_, i) => `word${i}`).join(" ")}</p>`;

describe("title_length", () => {
  it("passes between 30 and 60 characters", () => {
    expect(checkTitleLength("Spring Bike Service Checklist for Commuters", null)).toMatchObject({
      status: "pass",
      value: { length: 43, source: "post_title" },
    });
    expect(checkTitleLength("x".repeat(30), null).status).toBe("pass");
    expect(checkTitleLength("x".repeat(60), null).status).toBe("pass");
  });

  it("warns when too short or too long, and fails when empty", () => {
    expect(checkTitleLength("Hours & Location", null)).toMatchObject({ status: "warn", value: { length: 16 } });
    expect(checkTitleLength("x".repeat(61), null).status).toBe("warn");
    expect(checkTitleLength("   ", null).status).toBe("fail");
  });

  it("measures the Yoast SEO title when the site exposes one", () => {
    const result = checkTitleLength("Short", { title: "Spring Bike Service Checklist | Tidewater Cycle Works" });
    expect(result).toMatchObject({ status: "pass", value: { length: 53, source: "yoast_seo_title" } });
  });
});

describe("h1", () => {
  it("counts the title as the H1 by default", () => {
    expect(checkH1(parse("<h2>A</h2>"), true)).toMatchObject({ status: "pass", value: { effective_h1_count: 1 } });
  });

  it("warns about an extra H1 in the content", () => {
    expect(checkH1(parse("<h1>Opening Hours</h1><h2>A</h2>"), true)).toMatchObject({
      status: "warn",
      value: { h1_in_content: ["Opening Hours"], effective_h1_count: 2 },
    });
  });

  it("fails on a missing H1 when the title is not counted", () => {
    expect(checkH1(parse("<h2>A</h2>"), false).status).toBe("fail");
    expect(checkH1(parse("<h1>A</h1>"), false).status).toBe("pass");
    expect(checkH1(parse("<h1>A</h1><h1>B</h1>"), false).status).toBe("warn");
  });
});

describe("heading_order", () => {
  it("passes when levels step down one at a time, and going back up is fine", () => {
    expect(checkHeadingOrder(parse("<h2>A</h2><h3>B</h3><h4>C</h4><h2>D</h2>"), true).status).toBe("pass");
    expect(checkHeadingOrder(parse("<p>No headings</p>"), true)).toMatchObject({ status: "pass", message: "The content has no headings." });
  });

  it("reports each skipped level", () => {
    const result = checkHeadingOrder(parse("<h2>Find us</h2><h4>Parking</h4><h2>B</h2><h5>Deep</h5>"), true);
    expect(result.status).toBe("warn");
    expect((result.value as any).skips).toEqual([
      { from: 2, to: 4, heading: "Parking" },
      { from: 2, to: 5, heading: "Deep" },
    ]);
  });

  it("treats a first heading of H3 as a skip below the title", () => {
    expect(checkHeadingOrder(parse("<h3>A</h3>"), true).status).toBe("warn");
    expect(checkHeadingOrder(parse("<h3>A</h3>"), false).status).toBe("pass");
  });
});

describe("image_alt", () => {
  it("passes with no images or with alt text on all of them", () => {
    expect(checkImageAlt(parse("<p>Text</p>")).status).toBe("pass");
    expect(checkImageAlt(parse('<img src="a.jpg" alt="A wheel">')).status).toBe("pass");
  });

  it("warns and lists images with a missing or empty alt", () => {
    const result = checkImageAlt(parse('<img src="a.jpg"><img src="b.png" alt=""><img src="c.jpg" alt="  "><img src="d.jpg" alt="ok">'));
    expect(result).toMatchObject({
      status: "warn",
      value: { images: 4, missing_alt_attribute: ["a.jpg"], empty_alt: ["b.png", "c.jpg"] },
    });
  });
});

describe("links", () => {
  it("counts internal, external and other links", () => {
    const html = `<a href="/a/">a</a><a href="${SITE}/b/">b</a><a href="https://other.example.org/">c</a><a href="#x">d</a>`;
    expect(checkLinks(parse(html))).toMatchObject({ status: "pass", value: { internal: 2, external: 1, other: 1 } });
  });

  it("warns when there is no internal link", () => {
    expect(checkLinks(parse('<a href="https://other.example.org/">c</a>'))).toMatchObject({
      status: "warn",
      value: { internal: 0, external: 1, other: 0 },
    });
  });
});

describe("word_count", () => {
  it("warns under the threshold and passes at it", () => {
    expect(checkWordCount(parse(words(299)), 300)).toMatchObject({ status: "warn", value: { words: 299 } });
    expect(checkWordCount(parse(words(300)), 300).status).toBe("pass");
    expect(checkWordCount(parse(words(120)), 100).status).toBe("pass");
  });
});

describe("excerpt", () => {
  it("passes with a written excerpt, warns without, and says when it cannot tell", () => {
    expect(checkExcerpt("A short summary.")).toMatchObject({ status: "pass", value: { length: 16 } });
    expect(checkExcerpt("  ").status).toBe("warn");
    expect(checkExcerpt(null).status).toBe("not_available");
  });
});

describe("meta_description", () => {
  it("is not available without yoast_head_json", () => {
    expect(checkMetaDescription(null)).toMatchObject({ status: "not_available", value: null });
  });

  it("warns when Yoast data has no description, or one of the wrong length", () => {
    expect(checkMetaDescription({ title: "T" }).status).toBe("warn");
    expect(checkMetaDescription({ description: "Too short." }).status).toBe("warn");
    expect(checkMetaDescription({ description: "x".repeat(161) }).status).toBe("warn");
  });

  it("passes between 70 and 160 characters", () => {
    expect(checkMetaDescription({ description: "x".repeat(70) }).status).toBe("pass");
    expect(checkMetaDescription({ description: "x".repeat(160) })).toMatchObject({ status: "pass", value: { length: 160 } });
  });
});

describe("json_ld", () => {
  const ld = '<script type="application/ld+json">{"@type":"HowTo"}</script>';

  it("passes when JSON-LD is in the content or in the Yoast data", () => {
    expect(checkJsonLd(parse(ld), null)).toMatchObject({ status: "pass", value: { types_in_content: ["HowTo"] } });
    expect(checkJsonLd(parse("<p>x</p>"), { schema: { "@graph": [] } }).status).toBe("pass");
  });

  it("fails when a block does not parse", () => {
    expect(checkJsonLd(parse('<script type="application/ld+json">{oops}</script>'), null).status).toBe("fail");
  });

  it("warns when Yoast is exposed but reports no schema", () => {
    expect(checkJsonLd(parse("<p>x</p>"), { title: "T" }).status).toBe("warn");
  });

  it("is not available when nothing is in the content and the head cannot be seen", () => {
    expect(checkJsonLd(parse("<p>x</p>"), null).status).toBe("not_available");
  });
});

describe("auditContent on fixtures", () => {
  const run = (name: string) => {
    const post = fixture(name);
    return auditContent({
      title: post.title.raw ?? plainText(post.title.rendered),
      excerptRaw: post.excerpt.raw ?? null,
      yoast: post.yoast_head_json ?? null,
      parsed: parse(post.content.rendered),
    });
  };
  const statuses = (checks: ReturnType<typeof run>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

  it("passes every check on the well-formed page", () => {
    const checks = run("page-good");
    expect(statuses(checks)).toEqual({
      title_length: "pass",
      h1: "pass",
      heading_order: "pass",
      image_alt: "pass",
      links: "pass",
      word_count: "pass",
      excerpt: "pass",
      meta_description: "pass",
      json_ld: "pass",
    });
    expect(countByStatus(checks)).toEqual({ pass: 9, warn: 0, fail: 0, not_available: 0 });
  });

  it("flags the problems on the weak page and marks what it cannot see", () => {
    const checks = run("page-problems");
    expect(statuses(checks)).toEqual({
      title_length: "warn",
      h1: "warn",
      heading_order: "warn",
      image_alt: "warn",
      links: "warn",
      word_count: "warn",
      excerpt: "not_available",
      meta_description: "not_available",
      json_ld: "not_available",
    });
  });

  it("gives every check a message and a plain explanation", () => {
    for (const check of [...run("page-good"), ...run("page-problems")]) {
      expect(check.message.length).toBeGreaterThan(10);
      expect(check.explanation.length).toBeGreaterThan(40);
    }
  });

  it("is deterministic", () => {
    expect(run("page-problems")).toEqual(run("page-problems"));
  });
});
