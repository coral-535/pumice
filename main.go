package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

var version = "0.1.0-alpha"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "pumice-internal: this executable is managed by the Pumice Vite Task integration")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "lease":
		os.Exit(runLeaseHolder(os.Args[2:]))
	case "_daemon":
		os.Exit(runDaemon(os.Args[2:]))
	case "_exec":
		os.Exit(runExecSupervisor(os.Args[2:]))
	case "--version", "version":
		fmt.Printf("pumice-internal %s\n", version)
		return
	default:
		fmt.Fprintf(os.Stderr, "pumice-internal: unknown internal command %q\n", os.Args[1])
		os.Exit(2)
	}
}

func runLeaseHolder(args []string) int {
	flags := flag.NewFlagSet("lease", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	name := flags.String("name", "", "service name assigned by Vite Task")
	encoded := flags.String("definition", "", "base64url-encoded service definition")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *name == "" || *encoded == "" || flags.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "pumice-internal lease: --name and --definition are required")
		return 2
	}
	data, err := base64.RawURLEncoding.DecodeString(*encoded)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pumice-internal lease: decode definition: %v\n", err)
		return 2
	}
	var definition serviceDefinition
	if err := json.Unmarshal(data, &definition); err != nil {
		fmt.Fprintf(os.Stderr, "pumice-internal lease: parse definition: %v\n", err)
		return 2
	}
	definition.Name = *name
	definition.canonicalize()
	if err := definition.validate(); err != nil {
		fmt.Fprintf(os.Stderr, "pumice-internal lease: %v\n", err)
		return 2
	}
	root, err := canonicalWorktree(".")
	if err != nil {
		fmt.Fprintf(os.Stderr, "pumice-internal lease: %v\n", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runLeaseClient(ctx, root, &definition, os.Stdout); err != nil {
		if errors.Is(err, context.Canceled) {
			return 130
		}
		fmt.Fprintf(os.Stderr, "pumice-internal lease: %v\n", err)
		return 1
	}
	return 0
}
