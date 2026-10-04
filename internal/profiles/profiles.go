// Package profiles loads thin named Herdr launch presets. Name/default selection
// and literal home expansion are adapted from herdr-projects/src/profiles.rs.
package profiles

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type Profile struct {
	Agent       string   `yaml:"agent" json:"agent"`
	Args        []string `yaml:"args" json:"args"`
	Cwd         string   `yaml:"cwd,omitempty" json:"cwd,omitempty"`
	Description string   `yaml:"description" json:"description"`
	Tags        []string `yaml:"tags" json:"tags"`
}

// UnmarshalYAML refuses implicit number/bool-to-string conversion. Raw argv is
// a list of strings, and nested fields remain strict with this custom decoder.
func (p *Profile) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("profile must be a mapping")
	}
	for i := 0; i < len(node.Content); i += 2 {
		key, value := node.Content[i], node.Content[i+1]
		switch key.Value {
		case "agent", "description", "cwd":
			if value.Kind != yaml.ScalarNode || value.Tag != "!!str" {
				return fmt.Errorf("profile %s must be a string (line %d)", key.Value, value.Line)
			}
		case "args", "tags":
			if value.Kind != yaml.SequenceNode {
				return fmt.Errorf("profile %s must be a list of strings (line %d)", key.Value, value.Line)
			}
			for _, item := range value.Content {
				if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
					return fmt.Errorf("profile %s entries must be strings (line %d)", key.Value, item.Line)
				}
			}
		default:
			return fmt.Errorf("unknown profile field %q (line %d)", key.Value, key.Line)
		}
	}
	type plain Profile
	return node.Decode((*plain)(p))
}

type Defaults struct {
	WorkerProfile string `yaml:"worker_profile" json:"worker_profile"`
}
type Config struct {
	Profiles  map[string]Profile `yaml:"profiles" json:"profiles"`
	Defaults  Defaults           `yaml:"defaults" json:"defaults"`
	configDir string
}
type Summary struct {
	Name        string   `json:"name"`
	Agent       string   `json:"agent"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
}

var validName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

func Load(path string) (Config, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return Config{}, fmt.Errorf("resolve config path %s: %w", path, err)
	}
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("load profiles from %s: %w", path, err)
	}
	// This read-only file has no buffered writes; decoding reports read errors.
	defer func() { _ = file.Close() }()
	dec := yaml.NewDecoder(file)
	dec.KnownFields(true)
	var c Config
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("parse profiles in %s: %w", path, err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("only one YAML document is allowed")
		}
		return Config{}, fmt.Errorf("parse profiles in %s: %w", path, err)
	}
	if len(c.Profiles) == 0 {
		return Config{}, fmt.Errorf("%s: profiles must contain at least one named preset", path)
	}
	for name, p := range c.Profiles {
		if !validName.MatchString(name) {
			return Config{}, fmt.Errorf("%s: invalid profile name %q; use [a-z][a-z0-9_-]{0,31}", path, name)
		}
		if !validName.MatchString(p.Agent) {
			return Config{}, fmt.Errorf("%s: profile %q needs a valid Herdr agent kind", path, name)
		}
		for _, arg := range p.Args {
			if strings.ContainsRune(arg, 0) {
				return Config{}, fmt.Errorf("%s: profile %q contains a NUL argument", path, name)
			}
		}
	}
	if name := c.Defaults.WorkerProfile; name != "" {
		if _, ok := c.Profiles[name]; !ok {
			return Config{}, fmt.Errorf("%s: default worker profile %q is not defined", path, name)
		}
	}
	c.configDir = filepath.Dir(absPath)
	return c, nil
}

// Resolve returns an independent launch snapshot. Explicit selection overrides
// the configured default; no builtin provider or model is guessed.
func (c Config) Resolve(name string) (Profile, error) {
	if name == "" {
		name = c.Defaults.WorkerProfile
		if name == "" {
			return Profile{}, fmt.Errorf("no default worker profile; set defaults.worker_profile or select --profile")
		}
	}
	p, ok := c.Profiles[name]
	if !ok {
		return Profile{}, fmt.Errorf("unknown profile %q; use woof profile roster", name)
	}
	if !validName.MatchString(name) || !validName.MatchString(p.Agent) {
		return Profile{}, fmt.Errorf("invalid launch profile %q", name)
	}
	p.Args = append([]string{}, p.Args...)
	p.Tags = append([]string{}, p.Tags...)
	home, err := os.UserHomeDir()
	if err != nil {
		return Profile{}, fmt.Errorf("resolve home directory: %w", err)
	}
	for i, arg := range p.Args {
		if strings.HasPrefix(arg, "~/") {
			p.Args[i] = home + "/" + arg[2:]
		} else if before, after, ok := strings.Cut(arg, "=~/"); ok {
			p.Args[i] = before + "=" + home + "/" + after
		}
	}
	if p.Cwd != "" {
		cwd := p.Cwd
		if strings.HasPrefix(cwd, "~/") {
			cwd = filepath.Join(home, cwd[2:])
		} else if !filepath.IsAbs(cwd) {
			if c.configDir == "" {
				return Profile{}, fmt.Errorf("relative cwd in profile %q requires a loaded config file", name)
			}
			cwd = filepath.Join(c.configDir, cwd)
		}
		p.Cwd = filepath.Clean(cwd)
	}
	return p, nil
}

// Roster exposes selection metadata, with no raw arguments or environment.
func Roster(c Config) []Summary {
	names := make([]string, 0, len(c.Profiles))
	for name := range c.Profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]Summary, 0, len(names))
	for _, name := range names {
		p := c.Profiles[name]
		out = append(out, Summary{Name: name, Agent: p.Agent, Description: p.Description, Tags: append([]string{}, p.Tags...)})
	}
	return out
}
