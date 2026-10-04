// Package artifacts records caller-owned paths, never the file contents.
package artifacts

import (
	"fmt"
	"github.com/zielus/herdr-woof/internal/model"
	"os"
	"path/filepath"
	"strings"
)

type FileStatus struct {
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
	Readable bool   `json:"readable"`
	Error    string `json:"error,omitempty"`
}

func Resolve(paths []string, cwd string) ([]model.Artifact, error) {
	out := make([]model.Artifact, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		if path == "" || strings.ContainsRune(path, 0) {
			return nil, fmt.Errorf("artifact path must be nonempty and contain no NUL")
		}
		if strings.HasPrefix(path, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, fmt.Errorf("resolve artifact home: %w", err)
			}
			path = filepath.Join(home, path[2:])
		}
		if !filepath.IsAbs(path) {
			if !filepath.IsAbs(cwd) {
				return nil, fmt.Errorf("relative artifact %q requires the caller's absolute cwd", path)
			}
			path = filepath.Join(cwd, path)
		}
		path = filepath.Clean(path)
		if !seen[path] {
			out = append(out, model.Artifact{Path: path})
			seen[path] = true
		}
	}
	return out, nil
}

// Status probes existence and whether a file can be opened. Missing/unreadable
// paths remain visible; existence is never interpreted as completion evidence.
func Status(paths []model.Artifact) []FileStatus {
	out := make([]FileStatus, 0, len(paths))
	for _, a := range paths {
		s := FileStatus{Path: a.Path}
		info, err := os.Stat(a.Path)
		if err != nil {
			s.Error = err.Error()
		} else {
			s.Exists = true
			if !info.Mode().IsRegular() {
				s.Error = "artifact is not a regular file"
			} else if f, err := os.Open(a.Path); err != nil {
				s.Error = err.Error()
			} else {
				s.Readable = true
				if err := f.Close(); err != nil {
					s.Error = err.Error()
					s.Readable = false
				}
			}
		}
		out = append(out, s)
	}
	return out
}
