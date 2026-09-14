#!/usr/bin/env node
/**
 * `woof-mcp`: the stdio MCP server the Claude Code plugin registers (see
 * `plugin/claude/.mcp.json`). Exposes zero tools today — a placeholder for
 * the orchestration SDK's tool surface.
 */
import { VERSION } from "../version.js";
import { serveMcp } from "./serve.js";

await serveMcp({ name: "woof", version: VERSION, input: process.stdin, output: process.stdout });
