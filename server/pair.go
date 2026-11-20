package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// loopbackOnly reports whether addr (host:port) only accepts connections from this machine.
func loopbackOnly(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func tokenPath(dbPath string) string { return filepath.Join(filepath.Dir(dbPath), "relay-token") }

// relayToken returns the shared secret clients must send. RELAY_TOKEN wins. Otherwise, when the
// relay listens beyond loopback, a random token is created once and kept next to the database
// (mode 600), so a fresh install is never open to everyone on the network. RELAY_OPEN=1 opts out.
// tokenFile is non-empty when the generated/stored token is in use.
func relayToken(addr, dbPath string) (token, tokenFile string, err error) {
	if t := strings.TrimSpace(os.Getenv("RELAY_TOKEN")); t != "" {
		return t, "", nil
	}
	if loopbackOnly(addr) || os.Getenv("RELAY_OPEN") == "1" {
		return "", "", nil
	}
	p := tokenPath(dbPath)
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		return strings.TrimSpace(string(b)), p, nil
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	t := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(t+"\n"), 0o600); err != nil {
		return "", "", fmt.Errorf("can't save %s: %w", p, err)
	}
	return t, p, nil
}

// pairCommand prints a link that stores the token in a browser (`study-relay pair [base-url]`).
func pairCommand(args []string) int {
	token := strings.TrimSpace(os.Getenv("RELAY_TOKEN"))
	if token == "" {
		b, err := os.ReadFile(tokenPath(env("RELAY_DB", "study-relay.db")))
		if err != nil {
			fmt.Fprintln(os.Stderr, "No token yet. Start the relay once (it creates one when it listens on the network), or set RELAY_TOKEN.")
			return 1
		}
		token = strings.TrimSpace(string(b))
	}
	base := "http://localhost:8000"
	if len(args) > 0 {
		base = strings.TrimRight(args[0], "/")
	}
	fmt.Printf("Open this once on each device (it saves the token in that browser, then removes it from the address bar):\n\n  %s/#pair=%s\n\n", base, token)
	fmt.Printf("For Claude (MCP): add the header  Authorization: Bearer <token>  (the part after pair=).\n")
	return 0
}
