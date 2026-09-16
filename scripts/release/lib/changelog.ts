/**
 * CHANGELOG.md sections in Keep a Changelog form: `## [Unreleased]` and
 * `## [x.y.z] - YYYY-MM-DD`, each running to the next `## ` heading.
 */

export interface ChangelogSection {
  /** The heading line without `## `, e.g. `[0.1.0] - 2026-09-15`. */
  heading: string;
  /** Text after the heading line up to the next `## ` heading, trimmed. */
  body: string;
  /** Offsets of the heading line start and of the section end in the text. */
  start: number;
  end: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The section whose heading is `## [<name>]`, optionally followed by ` - <date>`. */
export function changelogSection(text: string, name: string): ChangelogSection | undefined {
  const heading = new RegExp(`^## \\[${escape(name)}\\]( - [^\\n]*)?$`, "m").exec(text);
  if (heading === null) return undefined;
  const bodyStart = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(bodyStart));
  const end = next === null ? text.length : bodyStart + next.index;
  return {
    heading: heading[0].slice(3),
    body: text.slice(bodyStart, end).trim(),
    start: heading.index,
    end,
  };
}

/** Why the release section for `version` is not usable, or undefined when it is. */
export function releaseSectionProblem(text: string, version: string): string | undefined {
  const section = changelogSection(text, version);
  if (section === undefined) return `CHANGELOG.md has no \`## [${version}]\` section`;
  const date = section.heading.slice(`[${version}]`.length);
  if (!date.startsWith(" - ") || !DATE.test(date.slice(3)))
    return `CHANGELOG.md \`## [${version}]\` is not dated as \`## [${version}] - YYYY-MM-DD\``;
  if (section.body === "") return `CHANGELOG.md \`## [${version}]\` has no entries`;
  return undefined;
}
