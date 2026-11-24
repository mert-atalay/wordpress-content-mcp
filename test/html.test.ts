import { describe, expect, it } from "vitest";

import { classifyLink, countWords, htmlToText, parseContent, plainText } from "../src/html.js";
import { fixture, SITE } from "./helpers.js";

describe("htmlToText", () => {
  it("keeps block elements on separate lines and decodes entities", () => {
    expect(htmlToText("<h2>Tyres &amp; tubes</h2><p>Check   the\n <strong>side</strong>walls.</p><ul><li>One</li><li>Two</li></ul>")).toBe(
      "Tyres & tubes\nCheck the sidewalls.\nOne\nTwo",
    );
  });

  it("leaves out scripts, styles and comments", () => {
    const html = '<p>Seen</p><script>var hidden = 1;</script><style>.x{color:red}</style><!-- note --><script type="application/ld+json">{"a":1}</script>';
    expect(htmlToText(html)).toBe("Seen");
  });

  it("returns an empty string for empty content", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("plainText and countWords", () => {
  it("decodes a rendered title", () => {
    expect(plainText("Why Your Gears Skip &#8211; and What to Do")).toBe("Why Your Gears Skip – and What to Do");
    expect(plainText("Hours &amp; Location")).toBe("Hours & Location");
  });

  it("counts words, treating hyphenated and apostrophe words as one", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("It's a well-known 10 mm bolt.")).toBe(6);
    expect(countWords("Çay içmek güzel")).toBe(3);
  });
});

describe("classifyLink", () => {
  it.each([
    [`${SITE}/guides/`, "internal"],
    ["https://www.tidewater-cycles.example/contact/", "internal"],
    ["/book-a-service/", "internal"],
    ["../relative/", "internal"],
    ["https://maps.example.org/tidewater", "external"],
    ["//cdn.example.net/file.pdf", "external"],
    ["#top", "other"],
    ["mailto:hello@tidewater-cycles.example", "other"],
    ["tel:+15550100", "other"],
    ["javascript:void(0)", "other"],
    ["", "other"],
  ])("%s is %s", (href, kind) => {
    expect(classifyLink(href, SITE)).toBe(kind);
  });
});

describe("parseContent on fixtures", () => {
  it("reads the outline, links, images and JSON-LD of a well-formed page", () => {
    const parsed = parseContent(fixture("page-good").content.rendered, SITE);
    expect(parsed.headings).toEqual([
      { level: 2, text: "Start with the tyres" },
      { level: 3, text: "How hard should they be?" },
      { level: 2, text: "Check the brakes" },
      { level: 3, text: "Cables and hoses" },
      { level: 2, text: "Clean and oil the chain" },
      { level: 2, text: "When to bring it in" },
    ]);
    expect(parsed.links.map((l) => [l.text, l.kind])).toEqual([
      ["tyre pressure guide", "internal"],
      ["set of repair articles", "external"],
      ["book a service", "internal"],
    ]);
    expect(parsed.images).toEqual([
      {
        src: `${SITE}/wp-content/uploads/2026/03/workstand-blue-commuter.jpg`,
        alt: "Blue commuter bike clamped in a workstand with the rear wheel removed",
      },
    ]);
    expect(parsed.jsonLd).toEqual([{ valid: true, types: ["HowTo"] }]);
    expect(parsed.wordCount).toBeGreaterThanOrEqual(300);
    expect(parsed.text).not.toContain("schema.org");
  });

  it("tells a missing alt attribute from an empty one", () => {
    const parsed = parseContent(fixture("page-problems").content.rendered, SITE);
    expect(parsed.images.map((img) => img.alt)).toEqual([null, ""]);
    expect(parsed.headings.map((h) => h.level)).toEqual([1, 2, 4]);
    expect(parsed.links.map((l) => l.kind)).toEqual(["external", "other", "other"]);
    expect(parsed.jsonLd).toEqual([]);
  });

  it("reads @graph types and flags JSON-LD that does not parse", () => {
    const html =
      '<script type="application/ld+json">{"@graph":[{"@type":"Article"},{"@type":["Person","Author"]}]}</script>' +
      '<script type="application/ld+json">{ not json }</script>' +
      "<script>var x = 1;</script>";
    expect(parseContent(html, SITE).jsonLd).toEqual([
      { valid: true, types: ["Article", "Person", "Author"] },
      { valid: false, types: [] },
    ]);
  });
});
