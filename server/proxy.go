package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// proxyRequest is what the browser posts to /api/canvas/proxy. Exactly one of the fields is set.
type proxyRequest struct {
	Path   string `json:"path"`    // "/api/v1/courses?enrollment_state=active"
	URL    string `json:"url"`     // absolute pagination "next" link on the Canvas host
	ICSURL string `json:"ics_url"` // private calendar feed on the Canvas host
}

const maxProxyBody = 8 << 20

var linkNext = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)

// canvasProxy forwards a browser request to Canvas so the browser avoids CORS.
// The Authorization header is passed through per request and never stored or logged.
func (s *Server) canvasProxy(w http.ResponseWriter, r *http.Request) {
	var req proxyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "bad JSON body")
		return
	}
	base, err := url.Parse(s.cfg.CanvasBase)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "bad CANVAS_BASE_URL")
		return
	}
	var target *url.URL
	withAuth := true
	switch {
	case req.Path != "":
		if !strings.HasPrefix(req.Path, "/api/v1/") || strings.Contains(req.Path, "..") {
			httpError(w, http.StatusBadRequest, "path must start with /api/v1/")
			return
		}
		target, err = base.Parse(req.Path)
	case req.URL != "":
		target, err = url.Parse(req.URL)
		if err == nil && !strings.HasPrefix(target.Path, "/api/v1/") {
			err = errBadTarget
		}
	case req.ICSURL != "":
		target, err = url.Parse(req.ICSURL)
		withAuth = false // feed URLs carry their own secret
		if err == nil && !strings.HasSuffix(target.Path, ".ics") {
			err = errBadTarget
		}
	default:
		httpError(w, http.StatusBadRequest, "one of path, url, ics_url is required")
		return
	}
	if err != nil || target.Scheme != base.Scheme || target.Host != base.Host {
		httpError(w, http.StatusBadRequest, "target must be on "+base.Host)
		return
	}

	out, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		httpError(w, http.StatusBadRequest, "bad target")
		return
	}
	out.Header.Set("Accept", "application/json+canvas-string-ids, application/json, text/calendar")
	if auth := r.Header.Get("Authorization"); withAuth && auth != "" {
		out.Header.Set("Authorization", auth)
	} else if withAuth && s.integ.CanvasToken != "" { // relay-held token from .env
		out.Header.Set("Authorization", "Bearer "+s.integ.CanvasToken)
	}
	resp, err := s.client.Do(out)
	if err != nil {
		httpError(w, http.StatusBadGateway, "canvas unreachable")
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if m := linkNext.FindStringSubmatch(resp.Header.Get("Link")); m != nil {
		w.Header().Set("X-Canvas-Next", m[1])
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, maxProxyBody))
}

type proxyErr string

func (e proxyErr) Error() string { return string(e) }

const errBadTarget = proxyErr("bad target")
