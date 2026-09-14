#!/usr/bin/env node
/**
 * `woof-agent-mcp`: the stdio MCP server a delegated agent session talks to.
 * Exposes zero tools today — a placeholder for the narrower surface a
 * coordinated agent will get (SPEC pending), distinct from `woof-mcp`'s
 * lead-session tool set.
 */
import { VERSION } from "../version.js";
import { serveMcp } from "./serve.js";

await serveMcp({
  name: "woof-agent",
  version: VERSION,
  input: process.stdin,
  output: process.stdout,
});
