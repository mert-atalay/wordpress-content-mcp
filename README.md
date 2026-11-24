# wordpress-content-mcp

A Model Context Protocol (MCP) server that lets an AI assistant read and audit a WordPress site through the standard WordPress REST API. It can propose content changes, but only as drafts. A person publishes.

I built it for marketing and SEO work: finding weak pages, checking headings and alt text, drafting rewrites. It is not a site administration tool.

This is an example and reference implementation. It is small on purpose, so the whole thing can be read in one sitting.

## What it does

- Lists and reads posts, pages and custom post types.
- Runs on-page checks on one page or on a sample of pages, and explains each check in plain words.
- Finds images in the media library that have no alt text.
- Saves new content as a draft.
- Saves a proposed change to an existing page as a separate draft copy. The original page is not touched.
- Sets the alt text of a media item. This is the one direct write.

It cannot publish, schedule, delete or edit a live page. There are no tools for that, and the request layer refuses those calls even if a tool tried.

## Why writes are limited to drafts

An assistant can misread a request or act on text it found inside a page. On a live site a mistake like that is public right away.

So the rule is simple. The assistant prepares. A person reviews the draft in WordPress and decides what goes live.

The rule is enforced in code, not only in the tool descriptions. Every request goes through one function in `src/wp-client.ts`. It works as an allowlist:

- `GET` is allowed.
- `POST` to a content collection such as `/posts` is allowed only to create a new item, and only with `status` set to `draft` or `pending`. Only `title`, `content`, `excerpt`, `slug` and `status` may be sent.
- `POST` to `/media/{id}` is allowed only when the body is exactly `{ "alt_text": "..." }`.
- Everything else is refused before any network call. That includes `DELETE`, `PUT`, `PATCH`, any update to an existing post or page, any other status (`publish`, `private`, `future`), the `_method` override and the `force` parameter, and writes to settings, users, comments, plugins, themes and terms.

The tests in `test/wp-client.test.ts` and `test/server.test.ts` cover these rules.

Use a WordPress account with a limited role as a second layer. Editor is enough. Do not give it an Administrator account.

## Requirements

- Node.js 20 or newer
- A WordPress site with the REST API reachable at `/wp-json` (WordPress 5.6 or newer for application passwords)
- A WordPress user and an application password for that user

## Setup

```bash
git clone <this repository>
cd wordpress-content-mcp
npm install
npm run build
```

Create the application password in WordPress under Users > Profile > Application Passwords.

Configuration is by environment variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `WP_BASE_URL` | yes | Site root, for example `https://example.com`. Must be `https`. Plain `http` is accepted only for `localhost`. |
| `WP_USERNAME` | yes | WordPress username. |
| `WP_APP_PASSWORD` | yes | Application password for that user. |
| `WP_READ_ONLY` | no | `true` turns off all writes. The three write tools are then not registered at all. |

The application password is sent as HTTP Basic auth on every request. That is why the server refuses to start with a non-HTTPS URL. Credentials are never logged and never returned in tool output or error messages.

### Claude Desktop

Add this to `claude_desktop_config.json`, with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "wordpress-content": {
      "command": "node",
      "args": ["/absolute/path/to/wordpress-content-mcp/dist/index.js"],
      "env": {
        "WP_BASE_URL": "https://example.com",
        "WP_USERNAME": "your-wordpress-username",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "WP_READ_ONLY": "false"
      }
    }
  }
}
```

### Claude Code

Use the same block in a `.mcp.json` file in your project, or add it from the command line:

```bash
claude mcp add wordpress-content \
  --env WP_BASE_URL=https://example.com \
  --env WP_USERNAME=your-wordpress-username \
  --env WP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \
  -- node /absolute/path/to/wordpress-content-mcp/dist/index.js
```

Keep real credentials out of files you commit.

## Tools

### Read

| Tool | What it does |
| --- | --- |
| `list_content` | Lists posts, pages or a custom post type. Supports `search`, `status`, `page` and `per_page`. Returns totals from the WordPress pagination headers. |
| `get_content` | Gets one item by `id`, or by URL or slug. Returns title, slug, status, modified date, rendered text, heading outline, links, and images with alt text. |
| `list_media_missing_alt` | Scans the media library for images with empty alt text. Bounded by `max_pages`, and says whether the scan was complete. |
| `list_taxonomies` | Lists taxonomies. With a `taxonomy`, lists its terms and their counts. |

### Audit

| Tool | What it does |
| --- | --- |
| `audit_page` | Runs the checks below on one post or page. |
| `audit_site` | Runs them on a bounded sample: the most recently modified published items of one type, 10 by default, 25 at most. Returns a summary table and counts per check. |

The checks are pure functions over the fetched content. The same content always gives the same result. No model is involved in the audit itself.

| Check | What it looks at |
| --- | --- |
| `title_length` | Title between 30 and 60 characters. Uses the Yoast SEO title when the site exposes it. |
| `h1` | Missing or multiple H1. By default the post title counts as the H1, because most themes print it that way. Set `title_is_h1` to `false` if yours does not. |
| `heading_order` | Skipped heading levels, such as H2 followed by H4. |
| `image_alt` | Images with a missing or empty `alt` attribute. |
| `links` | Counts of internal, external and other links. Warns when there is no internal link. |
| `word_count` | Flags content under 300 words as thin. Change it with `thin_content_words`. |
| `excerpt` | Whether a hand-written excerpt is set. |
| `meta_description` | Read from `yoast_head_json` when the Yoast SEO plugin exposes it. Otherwise reported as not available. |
| `json_ld` | Whether JSON-LD is present in the rendered content or in the Yoast data, and whether it parses. |

Each result has a status (`pass`, `warn`, `fail` or `not_available`), the measured values, a message about this page, and an explanation of why the check exists. The thresholds are common rules of thumb. They are not rules from any search engine.

### Write

| Tool | What it does |
| --- | --- |
| `create_draft` | Creates a new post or page. The status is always `draft`. There is no status argument. |
| `propose_revision` | Proposes a change to an existing item. It creates a new, separate copy titled `[Proposed revision of #ID] ...` with status `draft`, or `pending` if you ask for `pending_copy`. The original is only read. |
| `update_media_alt_text` | Direct write. Replaces the alt text of one media item and reports the previous value. Not available when `WP_READ_ONLY=true`. |

A note on `propose_revision`: setting an already published page to `pending` through the REST API would take it offline. So "pending" here always means a pending copy, never a status change on the original. After review, someone copies the change into the original and removes the copy by hand.

## Example prompts

- "List the 20 most recently changed pages."
- "Audit the page at https://example.com/services/ and explain what to fix first."
- "Run a site audit on 15 pages and show me the summary table. Which check fails most often?"
- "Which images in the media library have no alt text? Suggest alt text for the first five, but do not write anything yet."
- "Set the alt text of media item 91 to 'Mechanic fitting a new chain'."
- "Draft a 600 word post about spring bike maintenance and save it as a draft."
- "Propose a clearer title and intro for page 42. Save it as a proposal, do not touch the live page."

## Tests

```bash
npm run typecheck
npm test
```

The tests use `vitest` with a mocked `fetch`. No network and no WordPress are needed. The fixtures in `test/fixtures` are shaped like real WordPress REST responses. Their content is invented.

Covered: the auth header, the HTTPS rule, pagination, HTML parsing, every audit check, each tool through a real MCP client over an in-memory transport, and the write guardrails.

## Try it against a local WordPress

The `docker-compose.yml` starts a throwaway WordPress on `http://localhost:8080`.

```bash
docker compose up -d
```

1. Open `http://localhost:8080` and finish the WordPress install.
2. Go to Settings > Permalinks, choose "Post name" and save. Without this, `/wp-json` does not work.
3. Go to Users > Profile > Application Passwords and create one.
4. Start the server with `WP_BASE_URL=http://localhost:8080`, your username and the new application password.

`docker compose down -v` removes it again, including the data.

## Project layout

```
src/config.ts      environment variables, HTTPS rule, auth header
src/wp-client.ts   the single request layer and the write guard
src/html.ts        rendered HTML to text, headings, links, images, JSON-LD
src/audit.ts       the audit checks, as pure functions
src/content.ts     WordPress reads, audits and the three writes
src/server.ts      MCP tool definitions
src/index.ts       stdio entry point
```

## Limits

- The automated tests use mocked responses. I also ran it once by hand against a local WordPress 7.1 (WordPress Playground): listing and reading pages, `audit_page`, `create_draft` and `propose_revision` worked, and the published page was unchanged afterwards. I have not tried `update_media_alt_text`, Yoast fields or custom post types on a live site, and I have not run it against a range of hosts, themes or plugin setups. The Docker setup above is for trying it by hand; I have not run that file myself.
- It sees what the REST API returns, which is the content area of a post or page. It does not see the page head, menus, footers or anything a theme or page builder adds around the content. That is why some checks report "not available", and why the H1 check has to assume how the theme prints the title.
- Meta description is read only from Yoast SEO's `yoast_head_json`. Other SEO plugins are not supported.
- JSON-LD is checked for presence and for valid JSON. It is not validated against schema.org.
- The site must serve the REST API at `/wp-json`. Sites on plain permalinks (`?rest_route=`) are not supported.
- `audit_site` is a sample of up to 25 items, not a crawl. It does not follow links, check status codes or look for duplicates across pages.
- A draft copy made by `propose_revision` is a separate post. Merging it back is manual, and it does not appear in the original's revision history.
- Copies of hierarchical pages are created without a parent. Categories, tags, featured images and custom fields are not copied.
- Pages with very large content are cut to `max_chars` in `get_content`. There is no chunked reading.
- Only stdio transport. No HTTP transport, no OAuth, no multi-site support.
- It uses `@modelcontextprotocol/sdk` 1.x. A 2.x line of the SDK exists under different package names, and I have not ported this to it.
- The write guard limits what this server will send. It is not a replacement for WordPress roles and permissions.
- Other WordPress MCP servers exist, and some do far more. This one is intentionally narrow: read, audit, draft.

## License

MIT. See [LICENSE](LICENSE).
