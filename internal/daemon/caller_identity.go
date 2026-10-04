package daemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/zielus/herdr-woof/internal/model"
)

// Historical pane IDs are routing hints, not caller identities. Only a live
// descendant of the exact recorded agent process may inherit that old context.
func proveHistoricalCaller(ctx context.Context, callerPID int, recorded *model.ProcessIdentity) error {
	if recorded == nil || recorded.PID <= 0 || recorded.Birth == "" || callerPID <= 0 {
		return fmt.Errorf("recorded agent process and caller process are required")
	}
	if callerPID == recorded.PID {
		return fmt.Errorf("caller is not a descendant of the recorded agent")
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	birth, err := kernelBirth(recorded.PID)
	if err != nil || birth != recorded.Birth {
		return fmt.Errorf("recorded agent process birth is stale or unverifiable")
	}
	type observedProcess struct {
		pid   int
		birth string
	}
	var chain []observedProcess
	seen := map[int]bool{}
	current := callerPID
	for depth := 0; depth < 64; depth++ {
		if err := bounded.Err(); err != nil {
			return err
		}
		if current <= 0 || seen[current] {
			return fmt.Errorf("caller process ancestry does not reach the recorded agent")
		}
		seen[current] = true
		birth, err := kernelBirth(current)
		if err != nil {
			return fmt.Errorf("cannot verify ancestor process %d: %w", current, err)
		}
		chain = append(chain, observedProcess{current, birth})
		if current == recorded.PID {
			if birth != recorded.Birth {
				return fmt.Errorf("recorded agent process birth changed")
			}
			// Reject a process that disappeared/reused its PID while ancestry was read.
			for _, observed := range chain {
				if err := bounded.Err(); err != nil {
					return err
				}
				liveBirth, err := kernelBirth(observed.pid)
				if err != nil || liveBirth != observed.birth {
					return fmt.Errorf("caller ancestry changed during inspection")
				}
			}
			return nil
		}
		cmd := exec.CommandContext(bounded, "ps", "-p", strconv.Itoa(current), "-o", "ppid=")
		cmd.Env = append(os.Environ(), "LC_ALL=C")
		output, err := cmd.Output()
		if err != nil {
			return fmt.Errorf("cannot inspect caller ancestry: %w", err)
		}
		parent, err := strconv.Atoi(strings.TrimSpace(string(output)))
		if err != nil || parent <= 0 {
			return fmt.Errorf("caller ancestry has no proven recorded agent")
		}
		current = parent
	}
	return fmt.Errorf("caller ancestry exceeds the 64-process bound")
}
