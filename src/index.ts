#!/usr/bin/env node
/**
 * Entry point. Speaks MCP over stdio.
 * stdout carries the protocol, so anything for a human goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { createServer, SERVER_NAME } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // The host is logged, the username and application password never are.
  const mode = config.readOnly ? "read-only" : "drafts and alt text writes enabled";
  console.error(`${SERVER_NAME} running on stdio for ${new URL(config.baseUrl).host} (${mode})`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof ConfigError ? `Configuration error: ${message}` : `Fatal: ${message}`);
  process.exit(1);
});
