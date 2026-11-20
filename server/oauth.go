package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Standard MCP OAuth 2.1 + PKCE (S256) + Dynamic Client Registration (RFC 7591 / 8414 / 9728)
// so Google Gemini web chat and other OAuth-only MCP clients can connect cleanly.

type oauthClient struct {
	ClientID     string
	RedirectURIs []string
}

type oauthCode struct {
	ClientID    string
	RedirectURI string
	Challenge   string
	Method      string
	ExpiresAt   time.Time
}

type oauthStore struct {
	mu      sync.Mutex
	clients map[string]oauthClient
	codes   map[string]oauthCode
}

func newOAuthStore() *oauthStore {
	return &oauthStore{
		clients: map[string]oauthClient{},
		codes:   map[string]oauthCode{},
	}
}

func externalBaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if xf := r.Header.Get("X-Forwarded-Host"); xf != "" {
		host = xf
	}
	return scheme + "://" + host
}

func (s *Server) signOAuthToken(kind string, ttl time.Duration) string {
	exp := time.Now().Add(ttl).Unix()
	msg := fmt.Sprintf("%s.%d", kind, exp)
	mac := hmac.New(sha256.New, []byte(s.cfg.Token))
	_, _ = mac.Write([]byte(msg))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return msg + "." + sig
}

func (s *Server) verifyOAuthToken(tok, wantKind string) bool {
	if s.cfg.Token == "" {
		return true
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || parts[0] != wantKind {
		return false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	msg := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(s.cfg.Token))
	_, _ = mac.Write([]byte(msg))
	wantSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(parts[2]), []byte(wantSig)) == 1
}

func (s *Server) verifyTokenOrOAuth(got string) bool {
	if s.cfg.Token == "" {
		return true
	}
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) == 1 {
		return true
	}
	return s.verifyOAuthToken(got, "oat")
}

func (s *Server) oauthProtectedResourceHTTP(w http.ResponseWriter, r *http.Request) {
	base := externalBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + "/mcp",
		"authorization_servers":    []string{base},
		"bearer_methods_supported": []string{"header"},
	})
}

func (s *Server) oauthServerMetadataHTTP(w http.ResponseWriter, r *http.Request) {
	base := externalBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none", "client_secret_post"},
	})
}

func (s *Server) oauthRegisterHTTP(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&in); err != nil || len(in.RedirectURIs) == 0 {
		httpError(w, http.StatusBadRequest, "redirect_uris required")
		return
	}
	cid := "mcp-" + s.newID()
	s.oauth.mu.Lock()
	s.oauth.clients[cid] = oauthClient{ClientID: cid, RedirectURIs: in.RedirectURIs}
	s.oauth.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  cid,
		"client_name":                in.ClientName,
		"redirect_uris":              in.RedirectURIs,
		"token_endpoint_auth_method": "none",
	})
}

func (s *Server) oauthAuthorizeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	clientID := q.Get("client_id")
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")
	challenge := q.Get("code_challenge")
	method := q.Get("code_challenge_method")

	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		page := fmt.Sprintf(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Study Flow MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px;color:#1d1b2f;background:#f7f5ff}
.card{background:#fff;padding:24px;border-radius:18px;box-shadow:0 8px 28px rgba(40,30,90,.08)}
input{width:100%%;box-sizing:border-box;padding:10px 12px;margin:12px 0;border:1px solid #ccc;border-radius:10px;font-size:15px}
button{width:100%%;padding:11px;border:0;border-radius:12px;background:#7c5cff;color:#fff;font-weight:700;font-size:15px;cursor:pointer}</style></head>
<body><div class="card"><h2>Authorize Study Flow</h2><p>Enter your Relay Token to connect this MCP client to your schedule and tasks.</p>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="%s">
<input type="hidden" name="redirect_uri" value="%s">
<input type="hidden" name="state" value="%s">
<input type="hidden" name="code_challenge" value="%s">
<input type="hidden" name="code_challenge_method" value="%s">
<input type="password" name="relay_token" placeholder="Relay Token" required autofocus>
<button type="submit">Approve access</button></form></div></body></html>`,
			html.EscapeString(clientID), html.EscapeString(redirectURI), html.EscapeString(state),
			html.EscapeString(challenge), html.EscapeString(method))
		_, _ = io.WriteString(w, page)
		return
	}

	if err := r.ParseForm(); err != nil {
		httpError(w, http.StatusBadRequest, "bad form")
		return
	}
	clientID = r.FormValue("client_id")
	redirectURI = r.FormValue("redirect_uri")
	state = r.FormValue("state")
	challenge = r.FormValue("code_challenge")
	method = r.FormValue("code_challenge_method")
	tok := strings.TrimSpace(r.FormValue("relay_token"))

	if s.cfg.Token != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.Token)) != 1 {
		httpError(w, http.StatusUnauthorized, "invalid relay token")
		return
	}
	u, err := url.Parse(redirectURI)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		httpError(w, http.StatusBadRequest, "invalid redirect_uri")
		return
	}
	code := "code-" + s.newID() + s.newID()
	s.oauth.mu.Lock()
	s.oauth.codes[code] = oauthCode{
		ClientID:    clientID,
		RedirectURI: redirectURI,
		Challenge:   challenge,
		Method:      method,
		ExpiresAt:   time.Now().Add(5 * time.Minute),
	}
	s.oauth.mu.Unlock()

	vals := u.Query()
	vals.Set("code", code)
	if state != "" {
		vals.Set("state", state)
	}
	u.RawQuery = vals.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func (s *Server) oauthTokenHTTP(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpError(w, http.StatusBadRequest, "bad form")
		return
	}
	grant := r.FormValue("grant_type")
	switch grant {
	case "authorization_code":
		code := r.FormValue("code")
		redirectURI := r.FormValue("redirect_uri")
		verifier := r.FormValue("code_verifier")

		s.oauth.mu.Lock()
		c, ok := s.oauth.codes[code]
		if ok {
			delete(s.oauth.codes, code)
		}
		s.oauth.mu.Unlock()

		if !ok || time.Now().After(c.ExpiresAt) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		if c.RedirectURI != "" && redirectURI != "" && c.RedirectURI != redirectURI {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		if c.Challenge != "" {
			if c.Method != "" && c.Method != "S256" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
				return
			}
			sum := sha256.Sum256([]byte(verifier))
			got := base64.RawURLEncoding.EncodeToString(sum[:])
			if subtle.ConstantTimeCompare([]byte(got), []byte(c.Challenge)) != 1 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
				return
			}
		}
	case "refresh_token":
		rt := r.FormValue("refresh_token")
		if !s.verifyOAuthToken(rt, "ort") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  s.signOAuthToken("oat", 30*24*time.Hour),
		"refresh_token": s.signOAuthToken("ort", 90*24*time.Hour),
		"token_type":    "Bearer",
		"expires_in":    30 * 24 * 3600,
	})
}
