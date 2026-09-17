/**
 * CHANGELOG.md release sections, each running to the next `## ` heading. Two
 * heading forms: `## x.y.z`, written by Changesets from 0.1.3 on, and the
 * Keep a Changelog form `## [x.y.z] - YYYY-MM-DD` of the releases up to 0.1.1.
 */

export interface ChangelogSection {
  /** The heading line without `## `, e.g. `0.1.3` or `[0.1.0] - 2026-09-15`. */
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

/** The section whose heading is `## <name>`, or `## [<name>]` optionally followed by ` - <date>`. */
export function changelogSection(text: string, name: string): ChangelogSection | undefined {
  const heading = new RegExp(
    `^## (?:\\[${escape(name)}\\]( - [^\\n]*)?|${escape(name)})$`,
    "m",
  ).exec(text);
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

/**
 * Why the release section for `version` is not usable, or undefined when it is.
 * The date is required only in the bracketed Keep a Changelog form.
 */
export function releaseSectionProblem(text: string, version: string): string | undefined {
  const section = changelogSection(text, version);
  if (section === undefined) return `CHANGELOG.md has no \`## ${version}\` section`;
  if (section.heading.startsWith("[")) {
    const date = section.heading.slice(`[${version}]`.length);
    if (!date.startsWith(" - ") || !DATE.test(date.slice(3)))
      return `CHANGELOG.md \`## [${version}]\` is not dated as \`## [${version}] - YYYY-MM-DD\``;
  }
  if (section.body === "") return `CHANGELOG.md \`## ${section.heading}\` has no entries`;
  return undefined;
}
