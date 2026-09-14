#!/usr/bin/env node
/**
 * `woof`: the CLI entry point invoked by `bin/woof`, by the herdr plugin's
 * `doctor`/`runs` actions, and by the `runtime` pane. No orchestration logic
 * yet — each subcommand is a stub that proves the wiring end to end.
 */
import { execFileSync } from "node:child_process";

import { Command } from "commander";

import { VERSION } from "./version.js";

const program = new Command();

program.name("woof").description("Woof — orchestrate coding agents on Herdr").version(VERSION);

program
  .command("doctor")
  .description("Check herdr and Claude Code availability")
  .action(() => {
    console.log(`woof ${VERSION}`);
    console.log(probe("herdr", ["status"]));
    console.log(probe("claude", ["--version"]));
  });

program
  .command("runs")
  .description("List woof runs")
  .action(() => {
    console.log("no runs");
  });

program
  .command("runtime")
  .description("Run the herdr `runtime` pane")
  .action(() => {
    const runDir = process.env["WOOF_RUN_DIR"];
    console.log(`WOOF_RUN_DIR=${runDir ?? "(unset)"}`);
  });

await program.parseAsync(process.argv);

/** Runs a diagnostic command and reports its outcome; never throws. */
function probe(command: string, args: readonly string[]): string {
  try {
    const output = execFileSync(command, [...args], { encoding: "utf8" }).trim();
    return `${command} ${args.join(" ")}:\n${indent(output)}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return `${command} ${args.join(" ")}: not found (${detail})`;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
