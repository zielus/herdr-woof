//go:build darwin

package daemon

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
)

// Kernel microseconds distinguish births that ps lstart rounds to one second.
func kernelBirth(pid int) (string, error) {
	p, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	if p.Proc.P_pid != int32(pid) || p.Proc.P_stat == 5 {
		return "", os.ErrNotExist
	}
	return fmt.Sprintf("darwin:%d.%06d", p.Proc.P_starttime.Sec, p.Proc.P_starttime.Usec), nil
}
