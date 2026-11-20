// study-relay: tiny Go server for the client-heavy study scheduler.
//
// It serves the compiled web app from the binary, proxies Canvas requests (no stored
// credentials), stores the shared JSON state in SQLite, and exposes an MCP tool server so
// Claude Code / Claude Desktop can read and edit the schedule over Tailscale.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // the Pi image may lack zoneinfo
)

// version is set at build time by `make release VERSION=x.y.z`.
var version = "1.1.0"

//go:embed all:dist
var distFS embed.FS

type Config struct {
	CanvasBase     string
	Token          string // optional shared secret for /api/sync and /mcp
	AllowedOrigins []string
	LocalLLMURL    string
	LocalLLMModel  string
	LocalLLMCtx    int
	LocalLLMAPIKey string
}

type Server struct {
	store  *Store
	cfg    Config
	loc    *time.Location
	clock  func() time.Time
	client *http.Client
	sse    *mcpSessions
	static fs.FS
	integ  *Integrations
	oauth  *oauthStore
}

func NewServer(store *Store, cfg Config, loc *time.Location, clock func() time.Time) *Server {
	if clock == nil {
		clock = time.Now
	}
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	return &Server{
		store: store, cfg: cfg, loc: loc, clock: clock, static: sub,
		client: &http.Client{Timeout: 25 * time.Second, Transport: &http.Transport{
			MaxIdleConns: 8, MaxIdleConnsPerHost: 4, ForceAttemptHTTP2: true,
			IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
		}},
		sse:   &mcpSessions{m: map[string]*sseSession{}},
		integ: &Integrations{lastErr: map[string]string{}, PollEvery: 10 * time.Minute},
		oauth: newOAuthStore(),
	}
}

func (s *Server) now() time.Time { return s.clock().In(s.loc) }

func (s *Server) newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// Routes wires every endpoint.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sync", s.auth(s.getSync))
	mux.HandleFunc("POST /api/sync", s.auth(s.postSync))
	mux.HandleFunc("POST /api/canvas/proxy", s.auth(s.canvasProxy))
	mux.HandleFunc("POST /mcp", s.auth(s.originCheck(s.mcpPost)))
	mux.HandleFunc("GET /mcp/sse", s.auth(s.originCheck(s.mcpSSE)))
	mux.HandleFunc("GET /mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		httpError(w, http.StatusMethodNotAllowed, "use POST /mcp (or GET /mcp/sse for the SSE transport)")
	})
	mux.HandleFunc("GET /api/canvas/explore", s.auth(s.exploreHTTP))
	mux.HandleFunc("GET /api/integrations", s.auth(s.integrationsHTTP))
	mux.HandleFunc("GET /api/integrations/config", s.auth(s.getIntegrationsConfigHTTP))
	mux.HandleFunc("POST /api/integrations/config", s.auth(s.saveIntegrationsConfigHTTP))
	mux.HandleFunc("POST /api/integrations/poll", s.auth(s.pollHTTP))
	mux.HandleFunc("POST /api/integrations/test", s.auth(s.testHTTP))
	mux.HandleFunc("POST /api/email/send", s.auth(s.sendDraftHTTP))
	mux.HandleFunc("POST /api/discord/post", s.auth(s.discordPostHTTP))
	mux.HandleFunc("GET /api/llm/status", s.auth(s.localLLMStatusHTTP))
	mux.HandleFunc("POST /api/llm/chat", s.auth(s.localLLMChatHTTP))
	mux.HandleFunc("GET /api/presets", s.auth(s.presetsHTTP))
	mux.HandleFunc("POST /api/presets/apply", s.auth(s.applyPresetHTTP))
	mux.HandleFunc("GET /api/audit", s.auth(s.auditHTTP))
	mux.HandleFunc("GET /api/export/json", s.auth(s.exportJSONHTTP))
	mux.HandleFunc("GET /api/export/csv", s.auth(s.exportCSVHTTP))
	mux.HandleFunc("POST /api/account/reset", s.auth(s.accountResetHTTP))
	mux.HandleFunc("GET /api/counselor/digest", s.auth(s.counselorDigestHTTP))
	mux.HandleFunc("GET /api/report/transcript", s.auth(s.transcriptHTTP))
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.oauthProtectedResourceHTTP)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.oauthProtectedResourceHTTP)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.oauthServerMetadataHTTP)
	mux.HandleFunc("POST /oauth/register", s.oauthRegisterHTTP)
	mux.HandleFunc("GET /oauth/authorize", s.oauthAuthorizeHTTP)
	mux.HandleFunc("POST /oauth/authorize", s.oauthAuthorizeHTTP)
	mux.HandleFunc("POST /oauth/token", s.oauthTokenHTTP)
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /", s.serveStatic)
	return withSecurityHeaders(mux)
}

// auth enforces RELAY_TOKEN when set. The Canvas proxy uses X-Relay-Token because its
// Authorization header belongs to Canvas.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Token != "" {
			got := r.Header.Get("X-Relay-Token")
			if got == "" && !strings.HasPrefix(r.URL.Path, "/api/canvas") {
				got = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			}
			if !s.verifyTokenOrOAuth(got) {
				if strings.HasPrefix(r.URL.Path, "/mcp") {
					w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, externalBaseURL(r)))
				}
				httpError(w, http.StatusUnauthorized, "missing or bad relay token")
				return
			}
		}
		next(w, r)
	}
}

// originCheck blocks browser pages on other origins from driving MCP (DNS-rebinding guard).
func (s *Server) originCheck(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			ok := err == nil && u.Host == r.Host
			for _, a := range s.cfg.AllowedOrigins {
				ok = ok || o == a
			}
			if !ok {
				httpError(w, http.StatusForbidden, "origin not allowed")
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) getSync(w http.ResponseWriter, _ *http.Request) {
	v, st, err := s.store.Get()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	st.normalizeWeek(s.now())
	writeJSON(w, http.StatusOK, map[string]any{"version": v, "state": st, "server_time": s.now().Format(localLayout)})
}

func (s *Server) postSync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseVersion int64  `json:"base_version"`
		State       *State `json:"state"`
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, maxStateBytes+1024))
	if err := dec.Decode(&body); err != nil || body.State == nil {
		httpError(w, http.StatusBadRequest, "body must be {base_version, state}")
		return
	}
	body.State.Meta.UpdatedBy = "browser"
	body.State.Meta.UpdatedAt = s.now().Format(localLayout)
	nv, err := s.store.Put(body.BaseVersion, body.State)
	if errors.Is(err, ErrConflict) {
		v, cur, _ := s.store.Get()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "version conflict", "version": v, "state": cur})
		return
	}
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": nv})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	v, _, _ := s.store.Get()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version, "state_version": v,
		"heap_mb": round2(float64(m.HeapAlloc) / (1 << 20)), "sys_mb": round2(float64(m.Sys) / (1 << 20)),
		"goroutines": runtime.NumGoroutine()})
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if _, err := fs.Stat(s.static, p); err != nil {
		p = "index.html" // single-page app fallback
	}
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // hashed by Vite
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFileFS(w, r, s.static, p)
}

func (s *Server) exploreHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := s.canvasExplore(r.Context(), exploreArgs{What: q.Get("what"), Course: q.Get("course"), Search: q.Get("search")})
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) integrationsHTTP(w http.ResponseWriter, r *http.Request) {
	st := s.integ.Status()
	// the https address of this relay, so plain-http pages can move there (WebGPU needs https)
	pub := strings.TrimRight(os.Getenv("RELAY_PUBLIC_URL"), "/")
	if pub == "" && strings.HasSuffix(r.Host, ".ts.net") {
		pub = "https://" + r.Host
	}
	st["public_url"] = pub
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) pollHTTP(w http.ResponseWriter, r *http.Request) {
	added, err := s.pollOnce(r.Context())
	resp := map[string]any{"added": added}
	if err != nil {
		resp["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// sendDraftHTTP sends one draft the user approved in the UI (the only path that sends email).
func (s *Server) sendDraftHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DraftID string `json:"draft_id"`
		To      string `json:"to"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil || body.DraftID == "" {
		httpError(w, http.StatusBadRequest, "draft_id required")
		return
	}
	var d Draft
	_, _, err := s.store.Update(func(st *State) error { // apply the user's final edits first
		for i := range st.Drafts {
			if st.Drafts[i].ID == body.DraftID {
				if st.Drafts[i].Status == "sent" {
					return fmt.Errorf("already sent")
				}
				if body.To != "" {
					st.Drafts[i].To = body.To
				}
				if body.Subject != "" {
					st.Drafts[i].Subject = body.Subject
				}
				if body.Body != "" {
					st.Drafts[i].Body = body.Body
				}
				d = st.Drafts[i]
				return nil
			}
		}
		return fmt.Errorf("no draft %s", body.DraftID)
	})
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	sendErr := s.sendEmail(d)
	_, _, _ = s.store.Update(func(st *State) error {
		for i := range st.Drafts {
			if st.Drafts[i].ID == d.ID {
				if sendErr != nil {
					st.Drafts[i].Status, st.Drafts[i].Error = "failed", sendErr.Error()
				} else {
					st.Drafts[i].Status, st.Drafts[i].SentAt, st.Drafts[i].Error = "sent", s.now().Format(localLayout), ""
				}
			}
		}
		return nil
	})
	if sendErr != nil {
		httpError(w, http.StatusBadGateway, sendErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": d.To})
}

func (s *Server) discordPostHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil || strings.TrimSpace(body.Content) == "" {
		httpError(w, http.StatusBadRequest, "content required")
		return
	}
	if err := s.postDiscord(r.Context(), body.Content); err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"posted": true})
}

func env(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func main() {
	// Keep the Go heap small on a 1 GB Raspberry Pi: soft limit + eager GC.
	debug.SetMemoryLimit(20 << 20)
	debug.SetGCPercent(50)
	loadDotEnv(env("RELAY_ENV_FILE", ".env")) // credentials stay in memory, never in SQLite
	if len(os.Args) > 1 && os.Args[1] == "pair" {
		os.Exit(pairCommand(os.Args[2:]))
	}

	loc, err := time.LoadLocation(env("TZ_NAME", "America/Los_Angeles"))
	if err != nil {
		log.Fatalf("timezone: %v", err)
	}
	store, err := OpenStore(env("RELAY_DB", "study-relay.db"))
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer store.Close()
	var origins []string
	if o := os.Getenv("RELAY_ALLOWED_ORIGINS"); o != "" {
		origins = strings.Split(o, ",")
	}
	addr := env("RELAY_ADDR", "127.0.0.1:8000") // this machine only unless asked; see relayToken
	token, tokenFile, err := relayToken(addr, env("RELAY_DB", "study-relay.db"))
	if err != nil {
		log.Fatalf("relay token: %v", err)
	}
	if tokenFile != "" {
		log.Printf("relay is reachable from the network, so it requires a token (saved in %s). "+
			"Run `study-relay pair` to print a link that signs a device in. Set RELAY_TOKEN to choose your own.", tokenFile)
	}
	srv := NewServer(store, Config{
		CanvasBase: env("CANVAS_BASE_URL", "https://esuhsd.instructure.com"),
		Token:      token, AllowedOrigins: origins,
	}, loc, nil)
	srv.integ = IntegrationsFromEnv()
	hs := &http.Server{Addr: addr, Handler: srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	go srv.pollLoop(ctx)
	go srv.gradesLoop(ctx)
	log.Printf("study-relay %s listening on %s (integrations: %v)", version, hs.Addr, srv.integ.Status())
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
