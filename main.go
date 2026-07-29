package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

const version = "0.1.0"

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdout, os.Stderr))
}

func runCLI(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		fmt.Fprintf(stdout, "pum %s\n", version)
		return 0
	}
	if len(args) != 2 || args[0] != "run" {
		fmt.Fprintln(stderr, "Usage: pum run <task>")
		return 2
	}

	cfg, err := loadProjectConfig(".")
	if err != nil {
		fmt.Fprintf(stderr, "pum: %v\n", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runner, err := newRunner(cfg, stdout, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "pum: %v\n", err)
		return 1
	}
	if err := runner.Run(ctx, args[1]); err != nil {
		if errors.Is(err, context.Canceled) {
			return 130
		}
		fmt.Fprintf(stderr, "pum: %v\n", err)
		return 1
	}
	return 0
}
