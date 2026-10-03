// Package prompt conservatively detects empty agent editors and builds bounded
// references to durable Woof records. ANSI/editor detection is translated from
// herdr-projects/src/prompt_box.rs; see THIRD_PARTY_NOTICES.md.
package prompt

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/zielus/herdr-woof-v2/internal/model"
)

type State string

const (
	Empty   State = "empty"
	Typed   State = "typed"
	Unknown State = "unknown"
)

type cell struct {
	ch           rune
	dim, reverse bool
	bg           string
}
type line []cell

func parse(screen string) []line {
	var lines []line
	var row line
	var dim, reverse bool
	var bg string
	chars := []rune(screen)
	for i := 0; i < len(chars); i++ {
		ch := chars[i]
		if ch == '\x1b' {
			i++
			if i >= len(chars) {
				break
			}
			if chars[i] == '[' {
				start := i + 1
				i++
				for i < len(chars) && (chars[i] < 0x40 || chars[i] > 0x7e) {
					i++
				}
				if i < len(chars) && chars[i] == 'm' {
					sgr(string(chars[start:i]), &dim, &reverse, &bg)
				}
			} else if chars[i] == ']' {
				// OSC titles/links are not editor text.
				for i++; i < len(chars); i++ {
					if chars[i] == '\a' {
						break
					}
					if chars[i] == '\x1b' && i+1 < len(chars) && chars[i+1] == '\\' {
						i++
						break
					}
				}
			}
			continue
		}
		if ch == '\n' {
			lines = append(lines, row)
			row = nil
		} else if !unicode.IsControl(ch) {
			row = append(row, cell{ch, dim, reverse, bg})
		}
	}
	if len(row) > 0 {
		lines = append(lines, row)
	}
	return lines
}

func sgr(params string, dim, reverse *bool, bg *string) {
	codes := strings.Split(params, ";")
	for i := 0; i < len(codes); i++ {
		code := codes[i]
		switch code {
		case "0", "":
			*dim = false
			*reverse = false
			*bg = ""
		case "2":
			*dim = true
		case "22":
			*dim = false
		case "7":
			*reverse = true
		case "27":
			*reverse = false
		case "49":
			*bg = ""
		case "38", "48":
			take := 0
			if i+1 < len(codes) {
				switch codes[i+1] {
				case "5":
					take = 2
				case "2":
					take = 4
				}
			}
			end := min(i+1+take, len(codes))
			if code == "48" {
				*bg = strings.Join(codes[i+1:end], ";")
			}
			i = end - 1
		default:
			if len(code) == 2 && strings.HasPrefix(code, "4") || len(code) == 3 && strings.HasPrefix(code, "10") {
				*bg = code
			}
		}
	}
}

func text(row line) string {
	var b strings.Builder
	for _, c := range row {
		b.WriteRune(c.ch)
	}
	return b.String()
}
func starts(row line, prefix string) bool {
	return strings.HasPrefix(strings.TrimSpace(text(row)), prefix)
}
func rule(row line) bool {
	s := strings.TrimSpace(text(row))
	return len([]rune(s)) >= 10 && strings.Trim(s, "─") == ""
}
func after(row line, glyph rune) line {
	for i, c := range row {
		if c.ch == glyph {
			return row[i+1:]
		}
	}
	return nil
}
func last(lines []line, pred func(int, line) bool) int {
	for i := len(lines) - 1; i >= 0; i-- {
		if pred(i, lines[i]) {
			return i
		}
	}
	return -1
}

func input(kind string, lines []line) ([]line, bool) {
	switch kind {
	case "claude":
		at := last(lines, func(i int, row line) bool { return i > 0 && starts(row, "❯") && rule(lines[i-1]) })
		if at < 0 {
			return nil, false
		}
		for end := at + 1; end < len(lines); end++ {
			if rule(lines[end]) {
				return append([]line{after(lines[at], '❯')}, lines[at+1:end]...), true
			}
		}
	case "codex", "cursor":
		glyph := '›'
		if kind == "cursor" {
			glyph = '→'
		}
		at := last(lines, func(_ int, row line) bool { return starts(row, string(glyph)) })
		if at < 0 {
			return nil, false
		}
		rows := []line{after(lines[at], glyph)}
		// Wrapped drafts continue until the blank separating the status footer.
		for i := at + 1; i < len(lines) && strings.TrimSpace(text(lines[i])) != ""; i++ {
			rows = append(rows, lines[i])
		}
		return rows, true
	case "pi":
		bottom := last(lines, func(_ int, row line) bool { return rule(row) })
		if bottom < 0 {
			return nil, false
		}
		top := last(lines[:bottom], func(_ int, row line) bool { return rule(row) })
		if top < 0 {
			return nil, false
		}
		return lines[top+1 : bottom], true
	case "gemini":
		at := last(lines, func(_ int, row line) bool {
			if !starts(row, "│") {
				return false
			}
			s := strings.TrimSpace(text(after(row, '│')))
			return strings.HasPrefix(s, ">") || strings.HasPrefix(s, "!") || strings.HasPrefix(s, "*")
		})
		if at < 0 {
			return nil, false
		}
		var rows []line
		for i := at; i < len(lines); i++ {
			if starts(lines[i], "╰") {
				return rows, true
			}
			if !starts(lines[i], "│") {
				return nil, false
			}
			row := after(lines[i], '│')
			for j := len(row) - 1; j >= 0; j-- {
				if row[j].ch == '│' {
					row = row[:j]
					break
				}
			}
			if i == at {
				for j, c := range row {
					if c.ch == '>' || c.ch == '!' || c.ch == '*' {
						row = row[j+1:]
						break
					}
				}
			}
			rows = append(rows, row)
		}
	case "opencode":
		bottom := last(lines, func(_ int, row line) bool { return starts(row, "╹") })
		if bottom < 0 {
			return nil, false
		}
		top := bottom
		for top > 0 && starts(lines[top-1], "┃") {
			top--
		}
		if bottom-top < 2 {
			return nil, false
		}
		rows := make([]line, 0, bottom-top-1)
		for _, row := range lines[top : bottom-1] {
			row = after(row, '┃')
			if len(row) > 0 {
				bg := row[0].bg
				end := 0
				for end < len(row) && row[end].bg == bg {
					end++
				}
				row = row[:end]
			}
			rows = append(rows, row)
		}
		return rows, true
	}
	return nil, false
}

func typed(row line) string {
	var b strings.Builder
	for i, c := range row {
		if c.dim || unicode.IsSpace(c.ch) || (c.reverse && i+1 < len(row) && row[i+1].dim) {
			b.WriteRune(' ')
		} else {
			b.WriteRune(c.ch)
		}
	}
	return strings.TrimSpace(b.String())
}

// Inspect returns Unknown for layouts without a verified editor anchor, so no
// caller can treat an unrecognized menu or unsupported harness as an empty box.
func Inspect(kind, screen string) State {
	rows, ok := input(kind, parse(screen))
	if !ok {
		return Unknown
	}
	var texts []string
	for _, row := range rows {
		if t := typed(row); t != "" {
			texts = append(texts, t)
		}
	}
	if len(texts) == 0 {
		return Empty
	}
	if len(texts) == 1 && ((kind == "gemini" && texts[0] == "Type your message or @path/to/file") || (kind == "opencode" && (texts[0] == "Ask anything…" || texts[0] == `Ask anything… "Fix a TODO in the codebase"`))) {
		return Empty
	}
	return Typed
}
func Safe(kind, screen string) bool { return Inspect(kind, screen) == Empty }

func short(s string, limit int) string {
	var chars []rune
	for _, c := range s {
		if !unicode.IsControl(c) {
			chars = append(chars, c)
		} else if c == '\n' || c == '\r' || c == '\t' {
			chars = append(chars, ' ')
		}
	}
	if len(chars) > limit {
		if limit < 1 {
			return ""
		}
		return string(chars[:limit-1]) + "…"
	}
	return string(chars)
}

// Notice is a wakeup, not a handoff: full contents remain behind inbox/show.
// A supplied actor must be the verified worker snapshot used to persist this
// delivery's attachment; identities are never inferred from message recipients.
func Notice(messages []model.Message, actor ...model.Worker) string {
	const limit = 2000
	var b strings.Builder
	flags := ""
	if len(actor) == 1 {
		flags = actorFlags(actor[0].ID, actor[0].AttachmentID)
	}
	// strings.Builder writes cannot fail.
	_, _ = fmt.Fprintf(&b, "You have Woof messages. Run `woof inbox%s`; use `woof message show --id <message-id>%s` for full text and artifact paths. Acknowledge only after reading.\n", flags, flags)
	if flags != "" {
		_, _ = fmt.Fprintf(&b, "After reading: `woof ack --id <message-id>%s`. Answer questions: `woof reply --id <message-id> --body '<answer>'%s`. After handling: `woof consume --id <message-id>%s`.\n", flags, flags, flags)
	}
	for _, m := range messages {
		entry := fmt.Sprintf("Message %s: %s", short(m.ID, 80), short(strings.TrimSpace(m.Subject+" "+m.Body), 200))
		for _, a := range m.Artifacts {
			entry += "\nArtifact: " + strconv.Quote(short(a.Path, 400))
		}
		remaining := limit - len([]rune(b.String()))
		if remaining <= 1 {
			break
		}
		b.WriteString(short(entry, remaining-1))
		b.WriteByte('\n')
		if len([]rune(entry)) > remaining-1 {
			break
		}
	}
	return b.String()
}

func shellArg(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\r\n'\"`$\\;|&<>()*?[]{}!#~") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func actorFlags(workerID, attachmentID string) string {
	if strings.TrimSpace(workerID) == "" || strings.TrimSpace(attachmentID) == "" {
		return ""
	}
	return " --as-worker " + shellArg(workerID) + " --as-attachment " + shellArg(attachmentID)
}

// Dispatch references the caller-created handoff file. Reporting is tied to the
// dispatch's original attachment, never the current Herdr pane identifier.
func Dispatch(d model.Dispatch, w model.Worker) string {
	// A newer worker snapshot must never replace the dispatch's actor fence.
	flags := actorFlags(d.WorkerID, d.AttachmentID)
	tail := fmt.Sprintf("\nRead full dispatch details with `woof dispatch show --id %s%s`. When finished, run `woof done --dispatch %s --attachment %s%s --body '<summary>'`; add `--artifact <path>` for output files or `--failed` for failure. Reporting alone does not settle the dispatch; Woof also verifies this turn ended.", shellArg(d.ID), flags, shellArg(d.ID), shellArg(d.AttachmentID), flags)
	header := fmt.Sprintf("Woof dispatch %s for worker %s.\nSummary: %s", short(d.ID, 80), short(d.WorkerID, 80), short(d.Spec, 400))
	if d.Handoff != "" {
		header += "\nRead handoff file (path, not a command): " + strconv.Quote(short(d.Handoff, 600))
	}
	return short(header, max(0, 2000-len([]rune(tail)))) + tail
}
