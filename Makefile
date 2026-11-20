# Study Relay: build the web client, embed it, and cross-compile for a Raspberry Pi 4B.
GO ?= go
NPM ?= npm
BIN := study-relay

.PHONY: all web test test-go test-web build pi run clean release

all: web build

web:
	cd web && $(NPM) ci --no-audit --no-fund && $(NPM) run build   # writes server/dist

test: test-go test-web
test-go:
	cd server && $(GO) vet ./... && $(GO) test -count=1 ./...
test-web:
	cd web && $(NPM) test

VERSION ?= 1.1.0
LDFLAGS := -s -w -X main.version=$(VERSION)

build:
	cd server && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o ../$(BIN) .

# Raspberry Pi 4B (64-bit Raspberry Pi OS)
pi:
	cd server && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o ../$(BIN)-arm64 .

run: build
	cd server && ../$(BIN)

# Client bundles: one tarball per platform with the binary, service file, env template and docs.
# Built straight from the source files (no staging dir); never includes .env, databases or tokens.
DOCS := README.md study-relay.service setup-integrations.sh mcp-config.json
release: test web build pi
	mkdir -p release
	tar -czf release/study-relay-$(VERSION)-linux-amd64.tar.gz --transform 's,^server/.env.example,.env.example,;s,^,study-relay-$(VERSION)/,' $(BIN) $(DOCS) server/.env.example
	tar -czf release/study-relay-$(VERSION)-linux-arm64.tar.gz --transform 's,^$(BIN)-arm64,$(BIN),;s,^server/.env.example,.env.example,;s,^,study-relay-$(VERSION)/,' $(BIN)-arm64 $(DOCS) server/.env.example
	cd release && sha256sum study-relay-$(VERSION)-*.tar.gz > SHA256SUMS-$(VERSION) && ls -la

clean:
	rm -f $(BIN) $(BIN)-arm64
