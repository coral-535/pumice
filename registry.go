package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

type runtimePaths struct {
	dir        string
	socket     string
	startLock  string
	daemonLock string
	pid        string
	log        string
}

func newRuntimePaths(worktree string) (*runtimePaths, error) {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base != "" {
		base = filepath.Join(base, "pumice")
	}
	fallback := filepath.Join(os.TempDir(), "pumice-"+strconv.Itoa(os.Getuid()))
	if base == "" {
		base = fallback
	}

	sum := sha256.Sum256([]byte(worktree))
	key := hex.EncodeToString(sum[:12])
	dir, err := prepareRuntimeDirectory(base, key)
	if err != nil {
		if base == fallback {
			return nil, fmt.Errorf("create runtime directory: %w", err)
		}
		dir, err = prepareRuntimeDirectory(fallback, key)
		if err != nil {
			return nil, fmt.Errorf("create runtime directory: %w", err)
		}
		base = fallback
	}
	// Unix socket paths are limited to roughly 100 bytes on the supported
	// platforms. A deeply nested XDG_RUNTIME_DIR must not make the daemon
	// unusable, so place the entire runtime directory under the short fallback.
	if len(filepath.Join(dir, "daemon.sock")) >= 100 && base != fallback {
		dir, err = prepareRuntimeDirectory(fallback, key)
		if err != nil {
			return nil, fmt.Errorf("create short runtime directory: %w", err)
		}
	}

	return &runtimePaths{
		dir:        dir,
		socket:     filepath.Join(dir, "daemon.sock"),
		startLock:  filepath.Join(dir, "start.lock"),
		daemonLock: filepath.Join(dir, "daemon.lock"),
		pid:        filepath.Join(dir, "daemon.pid"),
		log:        filepath.Join(dir, "daemon.log"),
	}, nil
}

func prepareRuntimeDirectory(base, key string) (string, error) {
	if err := ensurePrivateDirectory(base); err != nil {
		return "", err
	}
	dir := filepath.Join(base, key)
	if err := ensurePrivateDirectory(dir); err != nil {
		return "", err
	}
	return dir, nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is not a private directory", path)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("%s is not owned by the current user", path)
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(path, 0o700); err != nil {
			return err
		}
	}
	return nil
}
