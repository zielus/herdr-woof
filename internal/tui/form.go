package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zielus/herdr-woof/internal/artifacts"
	"github.com/zielus/herdr-woof/internal/model"
	"unicode"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// FormReviewMsg asks the parent UI to review the frozen action. It never submits.
type FormReviewMsg struct{}

// Form edits payload only; its recipient, identity and scope are immutable.
type Form struct {
	action Action
	fields []textarea.Model
	labels []string
	focus  int
	option int
	cwd    string
	cwdErr error
}

// NewForm captures the operator cwd once, before editing and confirmation.
func NewForm(action Action) Form {
	cwd, err := os.Getwd()
	f := NewFormAt(action, cwd)
	f.cwdErr = err
	return f
}

// NewFormAt supplies an explicit operator cwd for embedding and deterministic
// tests. Relative artifacts require an absolute cwd; browsing scope is ignored.
func NewFormAt(action Action, cwd string) Form {
	f := Form{action: cloneAction(action), cwd: cwd}
	var values []string
	switch action.Kind {
	case "send", "ask", "reply":
		f.labels = []string{"Subject", "Body", "Artifacts (one path per line)"}
		values = []string{action.Subject, action.Body, strings.Join(action.Artifacts, "\n")}
	case "gate.resolve":
		if len(action.Options) > 0 {
			for i, o := range action.Options {
				if o == action.Decision {
					f.option = i
				}
			}
		} else {
			f.labels = []string{"Decision"}
			values = []string{action.Decision}
		}
	}
	for i, v := range values {
		field := textarea.New()
		field.ShowLineNumbers = false
		field.CharLimit = 0
		field.SetWidth(60)
		field.SetHeight(3)
		field.SetValue(v)
		if i == 0 {
			_ = field.Focus()
		}
		f.fields = append(f.fields, field)
	}
	return f
}

func (f Form) Update(msg tea.Msg) (Form, tea.Cmd) {
	if key, ok := msg.(tea.KeyPressMsg); ok {
		switch key.String() {
		case "ctrl+s":
			return f, func() tea.Msg { return FormReviewMsg{} }
		case "esc":
			return f, nil
		case "tab", "shift+tab":
			if len(f.fields) > 0 {
				f.fields[f.focus].Blur()
				delta := 1
				if key.String() == "shift+tab" {
					delta = -1
				}
				f.focus = (f.focus + delta + len(f.fields)) % len(f.fields)
				return f, f.fields[f.focus].Focus()
			}
		case "up", "k", "down", "j":
			if f.action.Kind == "gate.resolve" && len(f.action.Options) > 0 {
				delta := 1
				if key.String() == "up" || key.String() == "k" {
					delta = -1
				}
				f.option = (f.option + delta + len(f.action.Options)) % len(f.action.Options)
				return f, nil
			}
		}
	}
	if size, ok := msg.(tea.WindowSizeMsg); ok {
		for i := range f.fields {
			f.fields[i].SetWidth(max(1, size.Width-8))
			f.fields[i].SetHeight(max(1, (size.Height-10)/max(1, len(f.fields))))
		}
	}
	if len(f.fields) > 0 {
		var cmd tea.Cmd
		f.fields[f.focus], cmd = f.fields[f.focus].Update(msg)
		return f, cmd
	}
	return f, nil
}

func (f Form) Review() (Action, error) {
	a := cloneAction(f.action)
	switch a.Kind {
	case "send", "ask", "reply":
		a.Subject = f.fields[0].Value()
		a.Body = f.fields[1].Value()
		a.Artifacts = nil
		for _, line := range strings.Split(f.fields[2].Value(), "\n") {
			if p := strings.TrimSpace(line); p != "" {
				a.Artifacts = append(a.Artifacts, p)
			}
		}
	case "gate.resolve":
		if len(a.Options) > 0 {
			a.Decision = a.Options[f.option]
		} else {
			a.Decision = f.fields[0].Value()
		}
	}
	if err := validateAction(a); err != nil {
		return Action{}, err
	}
	if f.cwdErr != nil {
		for _, p := range a.Artifacts {
			if !filepath.IsAbs(p) && !strings.HasPrefix(p, "~/") {
				return Action{}, fmt.Errorf("resolve operator working directory: %w", f.cwdErr)
			}
		}
	}
	refs, err := artifacts.Resolve(a.Artifacts, f.cwd)
	if err != nil {
		return Action{}, err
	}
	a.Artifacts = nil
	for _, ref := range refs {
		a.Artifacts = append(a.Artifacts, ref.Path)
	}
	return a, nil
}

func (f Form) View(width, height int) string {
	var b strings.Builder
	b.WriteString(ansi.Truncate(formSafe(f.action.Kind+" · "+f.action.Label), max(1, width), "…") + "\n")
	if f.action.To != "" {
		b.WriteString(ansi.Truncate("To: "+formSafe(f.action.To), max(1, width), "…") + "\n")
	}
	for i, field := range f.fields {
		field.SetWidth(max(1, width-8))
		field.SetHeight(max(1, (height-10)/max(1, len(f.fields))))
		b.WriteString(f.labels[i] + "\n" + field.View() + "\n")
	}
	rows := max(0, height-strings.Count(b.String(), "\n")-1)
	start := max(0, min(f.option-rows+1, len(f.action.Options)-rows))
	for i := start; i < len(f.action.Options) && i < start+rows; i++ {
		prefix := "  "
		if i == f.option {
			prefix = "> "
		}
		b.WriteString(prefix + ansi.Truncate(formSafe(f.action.Options[i]), max(1, width-2), "…") + "\n")
	}
	footer := "Tab fields · Ctrl+s review · Esc cancel"
	if len(f.action.Options) > 0 {
		footer = "↑/↓ choices · Ctrl+s review · Esc cancel"
	}
	b.WriteString(ansi.Truncate(footer, max(1, width), "…"))
	return lipgloss.NewStyle().MaxWidth(max(1, width)).MaxHeight(max(1, height)).Render(b.String())
}

// Keep untrusted labels/options from emitting terminal commands in a form.
func formSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

// ArtifactReviewText shows the exact prepared references and their current
// accessibility. Missing/unreadable references remain allowed; no contents are
// read or attached, and status changes never alter the confirmed paths.
func ArtifactReviewText(a Action) string {
	refs := make([]model.Artifact, 0, len(a.Artifacts))
	for _, path := range a.Artifacts {
		refs = append(refs, model.Artifact{Path: path})
	}
	var b strings.Builder
	for _, status := range artifacts.Status(refs) {
		state := "readable"
		if !status.Exists {
			state = "missing"
		} else if !status.Readable {
			state = "unreadable"
		}
		b.WriteString(formSafe(status.Path) + " [" + state + "]")
		if status.Error != "" {
			b.WriteString(" — " + formSafe(status.Error))
		}
		b.WriteByte('\n')
	}
	return strings.TrimSuffix(b.String(), "\n")
}
