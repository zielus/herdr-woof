// Package paths resolves global Woof state independently of Herdr sessions.
// Long-path fallback adapted from herdr-orch (MIT, Copyright (c) 2026 Stephen Ellington).
package paths

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type Paths struct{ Dir, DB, Sock, Lock, Log, Config, Archive string }

func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe state directory %s", dir)
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() {
		return fmt.Errorf("state directory %s is not owned by current user", dir)
	}
	return os.Chmod(dir, 0700)
}
func Resolve() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	dir := os.Getenv("WOOF_STATE_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".woof")
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return Paths{}, err
	}
	if err = privateDir(dir); err != nil {
		return Paths{}, err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return Paths{}, err
	}
	archive := filepath.Join(dir, "archive")
	if err = privateDir(archive); err != nil {
		return Paths{}, err
	}
	sock := filepath.Join(dir, "woof.sock")
	if len(sock) > 100 {
		short := filepath.Join("/tmp", fmt.Sprintf("woof-%d", os.Getuid()))
		if err = privateDir(short); err != nil {
			return Paths{}, err
		}
		sum := sha256.Sum256([]byte(dir))
		sock = filepath.Join(short, hex.EncodeToString(sum[:16])+".sock")
	}
	config := os.Getenv("WOOF_CONFIG")
	if config == "" {
		config = filepath.Join(home, ".woof", "config.yml")
	}
	config, err = filepath.Abs(config)
	if err != nil {
		return Paths{}, err
	}
	return Paths{Dir: dir, DB: filepath.Join(dir, "woof.db"), Sock: sock, Lock: filepath.Join(dir, "woof.lock"), Log: filepath.Join(dir, "daemon.log"), Config: config, Archive: archive}, nil
}
