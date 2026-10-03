//go:build linux

package daemon

import (
	"fmt"
	"os"
	"strings"
)

func kernelBirth(pid int) (string, error) {
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	end := strings.LastIndexByte(string(stat), ')')
	if end < 0 {
		return "", fmt.Errorf("invalid process stat")
	}
	parts := strings.Fields(string(stat)[end+1:])
	if len(parts) <= 19 {
		return "", fmt.Errorf("truncated process stat")
	}
	if parts[0] == "Z" {
		return "", os.ErrNotExist
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + parts[19], nil
}
