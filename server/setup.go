package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Check is the result of one connection self-test. Detail never contains secrets.
type Check struct {
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Detail     string `json:"detail"`
}

// smtpDial connects (implicit TLS on 465, STARTTLS otherwise) and logs in.
func smtpDial(c SMTPConfig) (*smtp.Client, error) {
	host, port, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return nil, fmt.Errorf("SMTP_ADDR must be host:port")
	}
	d := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	if port == "465" {
		conn, err = tls.DialWithDialer(d, "tcp", c.Addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = d.Dial("tcp", c.Addr)
	}
	if err != nil {
		return nil, fmt.Errorf("can't reach %s", c.Addr)
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	cl, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("%s did not answer like a mail server", c.Addr)
	}
	if port != "465" {
		if ok, _ := cl.Extension("STARTTLS"); ok {
			if err := cl.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
				cl.Close()
				return nil, fmt.Errorf("secure connection to %s failed", host)
			}
		}
	}
	if c.User != "" {
		if ok, _ := cl.Extension("AUTH"); ok {
			if err := cl.Auth(smtp.PlainAuth("", c.User, c.Password, host)); err != nil {
				cl.Close()
				return nil, fmt.Errorf("login rejected: check the address and app password")
			}
		}
	}
	return cl, nil
}

func smtpSend(c SMTPConfig, rcpt []string, msg []byte) error {
	from := c.From
	if a, err := mail.ParseAddress(c.From); err == nil {
		from = a.Address
	}
	cl, err := smtpDial(c)
	if err != nil {
		return err
	}
	defer cl.Close()
	if err := cl.Mail(from); err != nil {
		return fmt.Errorf("server refused sender %s", from)
	}
	for _, r := range rcpt {
		if err := cl.Rcpt(r); err != nil {
			return fmt.Errorf("server refused recipient %s", r)
		}
	}
	w, err := cl.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return cl.Quit()
}

func discordErr(status int, what string) string {
	switch status {
	case 401:
		return "bot token rejected (copy it again from the Developer Portal: Bot → Reset Token)"
	case 403:
		return what + ": the bot can't see it (invite the bot, and give it View Channel + Read Message History)"
	case 404:
		return what + ": not found (check the ID; turn on Developer Mode, right-click the channel → Copy Channel ID)"
	}
	return fmt.Sprintf("%s: Discord returned %d", what, status)
}

func (s *Server) discordGet(ctx context.Context, u string, auth bool, out any) (int, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if auth {
		req.Header.Set("Authorization", "Bot "+s.integ.Discord.BotToken)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("discord unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 300 && out != nil {
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
	}
	return resp.StatusCode, nil
}

// testIntegrations checks every configured connection without posting or sending anything.
func (s *Server) testIntegrations(ctx context.Context) map[string]Check {
	out := map[string]Check{}
	d := s.integ.Discord

	// Discord bot: who am I, then read one message from each channel
	c := Check{Configured: d.BotToken != "" && len(d.ChannelIDs) > 0}
	if c.Configured {
		var me struct {
			Username string `json:"username"`
		}
		st, err := s.discordGet(ctx, d.APIBase+"/users/@me", true, &me)
		switch {
		case err != nil:
			c.Detail = err.Error()
		case st != 200:
			c.Detail = discordErr(st, "bot")
		default:
			c.OK, c.Detail = true, "bot "+me.Username+" can read "+fmt.Sprint(len(d.ChannelIDs))+" channel(s)"
			emptyOnly := true
			for _, ch := range d.ChannelIDs {
				var msgs []struct {
					Content     string `json:"content"`
					Attachments []any  `json:"attachments"`
				}
				st, err := s.discordGet(ctx, d.APIBase+"/channels/"+url.PathEscape(ch)+"/messages?limit=5", true, &msgs)
				if err != nil || st != 200 {
					c.OK = false
					if err != nil {
						c.Detail = err.Error()
					} else {
						c.Detail = discordErr(st, "channel "+ch)
					}
					break
				}
				for _, m := range msgs {
					if m.Content != "" || len(m.Attachments) > 0 {
						emptyOnly = emptyOnly && m.Content == ""
					}
				}
			}
			if c.OK && emptyOnly {
				c.Detail += " (if messages show up blank, turn on Message Content Intent under Bot in the Developer Portal)"
			}
		}
	}
	out["discord_read"] = c

	// Discord webhook: GET returns its info without posting
	c = Check{Configured: d.WebhookURL != ""}
	if c.Configured {
		var hook struct {
			Name string `json:"name"`
		}
		st, err := s.discordGet(ctx, d.WebhookURL, false, &hook)
		switch {
		case err != nil:
			c.Detail = err.Error()
		case st != 200:
			c.Detail = fmt.Sprintf("webhook URL rejected (%d): create a new one in Channel Settings → Integrations → Webhooks", st)
		default:
			c.OK, c.Detail = true, "webhook “"+hook.Name+"” is ready (nothing was posted)"
		}
	}
	out["discord_post"] = c

	// IMAP: log in and open the inbox read-only
	im := s.integ.IMAP
	c = Check{Configured: im.Addr != "" && im.User != ""}
	if c.Configured {
		ic, err := dialIMAP(im)
		if err != nil {
			c.Detail = "can't reach " + im.Addr
		} else {
			if _, err := ic.cmd("LOGIN %s %s", imapQuote(im.User), imapQuote(im.Password)); err != nil {
				c.Detail = "login rejected: use an app password (Gmail: 2-Step Verification on, then myaccount.google.com/apppasswords)"
			} else if lines, err := ic.cmd("EXAMINE INBOX"); err != nil {
				c.Detail = "logged in but couldn't open INBOX"
			} else {
				n := "?"
				for _, l := range lines {
					if f := strings.Fields(string(l)); len(f) == 3 && f[2] == "EXISTS" {
						n = f[1]
					}
				}
				filt := "all senders"
				if len(im.Filters) > 0 {
					filt = "only mail matching: " + strings.Join(im.Filters, ", ")
				}
				c.OK, c.Detail = true, "signed in as "+im.User+" ("+n+" messages; keeping "+filt+")"
				_, _ = ic.cmd("LOGOUT")
			}
			ic.c.Close()
		}
	}
	out["email_read"] = c

	// SMTP: connect, secure, log in, quit (no message is sent)
	sm := s.integ.SMTP
	c = Check{Configured: sm.Addr != "" && sm.From != ""}
	if c.Configured {
		if cl, err := smtpDial(sm); err != nil {
			c.Detail = err.Error()
		} else {
			_ = cl.Quit()
			c.OK, c.Detail = true, "can send as "+sm.From+" (nothing was sent)"
		}
	}
	out["email_send"] = c

	for k, v := range out {
		if v.Configured {
			if v.OK {
				s.integ.setErr(strings.SplitN(k, "_", 2)[0], nil)
			}
		} else {
			v.Detail = "not set up"
			out[k] = v
		}
	}
	return out
}

func (s *Server) testHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.testIntegrations(ctx))
}

func (s *Server) getIntegrationsConfigHTTP(w http.ResponseWriter, _ *http.Request) {
	baseURL, model, ctxLen, apiKey := localLLMConfig(s.cfg)
	writeJSON(w, http.StatusOK, map[string]any{
		"canvas_base_url":            s.cfg.CanvasBase,
		"canvas_configured":          s.integ.CanvasToken != "",
		"imap_addr":                  s.integ.IMAP.Addr,
		"imap_user":                  s.integ.IMAP.User,
		"imap_filters":               strings.Join(s.integ.IMAP.Filters, ","),
		"imap_configured":            s.integ.IMAP.Addr != "" && s.integ.IMAP.User != "" && s.integ.IMAP.Password != "",
		"smtp_addr":                  s.integ.SMTP.Addr,
		"smtp_user":                  s.integ.SMTP.User,
		"smtp_from":                  s.integ.SMTP.From,
		"smtp_configured":            s.integ.SMTP.Addr != "" && s.integ.SMTP.Password != "",
		"discord_channel_ids":        strings.Join(s.integ.Discord.ChannelIDs, ","),
		"discord_bot_configured":     s.integ.Discord.BotToken != "",
		"discord_webhook_configured": s.integ.Discord.WebhookURL != "",
		"local_llm_url":              baseURL,
		"local_llm_model":            model,
		"local_llm_ctx":              ctxLen,
		"local_llm_key_configured":   apiKey != "",
		"openrouter_key_configured":  strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")) != "",
		"openai_key_configured":      strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) != "",
		"azure_key_configured":       strings.TrimSpace(os.Getenv("AZURE_OPENAI_API_KEY")) != "",
		"local_key_configured":       strings.TrimSpace(os.Getenv("LOCAL_LLM_API_KEY")) != "",
	})
}

func upsertDotEnv(path string, updates map[string]string) error {
	if len(updates) == 0 {
		return nil
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		_ = os.MkdirAll(dir, 0o700)
	}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := []string{}
	if len(raw) > 0 {
		lines = strings.Split(strings.TrimRight(string(raw), "\r\n"), "\n")
	}
	seen := map[string]bool{}
	for i, line := range lines {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if eq := strings.IndexByte(t, '='); eq > 0 {
			k := strings.TrimSpace(t[:eq])
			if v, ok := updates[k]; ok {
				lines[i] = k + "=" + v
				seen[k] = true
			}
		}
	}
	for k, v := range updates {
		if !seen[k] {
			lines = append(lines, k+"="+v)
		}
	}
	tmp := path + ".tmp"
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func cleanEnvVal(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	return strings.TrimSpace(s)
}

func (s *Server) saveIntegrationsConfigHTTP(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CanvasBaseURL   string `json:"canvas_base_url"`
		CanvasAPIToken  string `json:"canvas_api_token"`
		EmailProvider   string `json:"email_provider"`
		EmailUser       string `json:"email_user"`
		EmailPassword   string `json:"email_password"`
		IMAPAddr        string `json:"imap_addr"`
		IMAPFilters     string `json:"imap_filters"`
		SMTPAddr        string `json:"smtp_addr"`
		DiscordBotToken string `json:"discord_bot_token"`
		DiscordChannels string `json:"discord_channel_ids"`
		DiscordWebhook  string `json:"discord_webhook_url"`
		LocalLLMURL     string `json:"local_llm_url"`
		LocalLLMModel   string `json:"local_llm_model"`
		LocalLLMCtx     int    `json:"local_llm_ctx"`
		LocalLLMAPIKey  string `json:"local_llm_api_key"`
		LLMProvider     string `json:"llm_provider"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&in); err != nil {
		httpError(w, http.StatusBadRequest, "invalid json")
		return
	}
	updates := map[string]string{}
	set := func(k, v string) {
		if v = cleanEnvVal(v); v != "" {
			updates[k] = v
		}
	}
	set("CANVAS_BASE_URL", in.CanvasBaseURL)
	set("CANVAS_API_TOKEN", in.CanvasAPIToken)
	switch strings.ToLower(strings.TrimSpace(in.EmailProvider)) {
	case "gmail":
		updates["IMAP_ADDR"] = "imap.gmail.com:993"
		updates["SMTP_ADDR"] = "smtp.gmail.com:587"
	case "icloud":
		updates["IMAP_ADDR"] = "imap.mail.me.com:993"
		updates["SMTP_ADDR"] = "smtp.mail.me.com:587"
	case "yahoo":
		updates["IMAP_ADDR"] = "imap.mail.yahoo.com:993"
		updates["SMTP_ADDR"] = "smtp.mail.yahoo.com:587"
	}
	set("IMAP_ADDR", in.IMAPAddr)
	set("SMTP_ADDR", in.SMTPAddr)
	if u := cleanEnvVal(in.EmailUser); u != "" {
		updates["IMAP_USER"] = u
		updates["SMTP_USER"] = u
		updates["SMTP_FROM"] = u
	}
	if p := cleanEnvVal(in.EmailPassword); p != "" {
		updates["IMAP_PASSWORD"] = p
		updates["SMTP_PASSWORD"] = p
	}
	if in.IMAPFilters != "" {
		updates["IMAP_FILTERS"] = cleanEnvVal(in.IMAPFilters)
	}
	set("DISCORD_BOT_TOKEN", in.DiscordBotToken)
	if in.DiscordChannels != "" {
		updates["DISCORD_CHANNEL_IDS"] = cleanEnvVal(in.DiscordChannels)
	}
	set("DISCORD_WEBHOOK_URL", in.DiscordWebhook)
	set("LOCAL_LLM_URL", in.LocalLLMURL)
	set("LOCAL_LLM_MODEL", in.LocalLLMModel)
	provider := strings.ToLower(strings.TrimSpace(in.LLMProvider))
	switch provider {
	case "openrouter":
		set("OPENROUTER_API_KEY", in.LocalLLMAPIKey)
	case "openai":
		set("OPENAI_API_KEY", in.LocalLLMAPIKey)
	case "azure":
		set("AZURE_OPENAI_API_KEY", in.LocalLLMAPIKey)
	default:
		set("LOCAL_LLM_API_KEY", in.LocalLLMAPIKey)
	}
	if in.LocalLLMCtx >= 1024 {
		updates["LOCAL_LLM_CTX"] = fmt.Sprintf("%d", in.LocalLLMCtx)
	}

	envPath := env("RELAY_ENV_FILE", ".env")
	if err := upsertDotEnv(envPath, updates); err != nil {
		httpError(w, http.StatusInternalServerError, "could not save .env: "+err.Error())
		return
	}
	for k, v := range updates {
		_ = os.Setenv(k, v)
	}
	if v := updates["CANVAS_BASE_URL"]; v != "" {
		s.cfg.CanvasBase = v
	}
	if v := updates["LOCAL_LLM_URL"]; v != "" {
		s.cfg.LocalLLMURL = v
	}
	if v := updates["LOCAL_LLM_MODEL"]; v != "" {
		s.cfg.LocalLLMModel = v
	}
	if v := updates["LOCAL_LLM_API_KEY"]; v != "" {
		s.cfg.LocalLLMAPIKey = v
	}
	if in.LocalLLMCtx >= 1024 {
		s.cfg.LocalLLMCtx = in.LocalLLMCtx
	}
	s.integ = IntegrationsFromEnv()
	keys := make([]string, 0, len(updates))
	for k := range updates {
		keys = append(keys, k)
	}
	s.store.LogAudit("http", "save_integrations", strings.Join(keys, ","))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": s.integ.Status()})
}
