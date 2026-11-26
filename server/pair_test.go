package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestRelayTokenDefaults(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "x.db")
	t.Setenv("RELAY_TOKEN", "")
	t.Setenv("RELAY_OPEN", "")

	if tok, _, _ := relayToken("127.0.0.1:8000", db); tok != "" {
		t.Fatal("loopback-only relay should not need a token")
	}
	tok, file, err := relayToken(":8000", db)
	if err != nil || len(tok) < 32 || file == "" {
		t.Fatalf("network relay must get a token: %q %q %v", tok, file, err)
	}
	if st, _ := os.Stat(file); st.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode %v", st.Mode().Perm())
	}
	again, _, _ := relayToken("0.0.0.0:8000", db)
	if again != tok {
		t.Fatal("token must be stable across restarts")
	}
	t.Setenv("RELAY_TOKEN", "mine")
	if got, f, _ := relayToken(":8000", db); got != "mine" || f != "" {
		t.Fatal("RELAY_TOKEN must win")
	}
	t.Setenv("RELAY_TOKEN", "")
	t.Setenv("RELAY_OPEN", "1")
	if got, _, _ := relayToken(":8000", db); got != "" {
		t.Fatal("RELAY_OPEN=1 opts out")
	}
}

func TestOpenRouterKeyFallback(t *testing.T) {
	t.Setenv("LOCAL_LLM_API_KEY", "legacy-generic-key")
	t.Setenv("OPENAI_API_KEY", "sk-openai")
	t.Setenv("OPENROUTER_API_KEY", "sk-or")
	t.Setenv("LOCAL_LLM_URL", "https://openrouter.ai/api/v1")
	if _, _, _, k := localLLMConfig(Config{}); k != "sk-or" {
		t.Fatalf("openrouter url should use OPENROUTER_API_KEY, got %q", k)
	}
	t.Setenv("LOCAL_LLM_URL", "https://api.openai.com/v1")
	if _, _, _, k := localLLMConfig(Config{}); k != "sk-openai" {
		t.Fatalf("openai url should use OPENAI_API_KEY, got %q", k)
	}
	t.Setenv("AZURE_OPENAI_API_KEY", "az-test")
	t.Setenv("LOCAL_LLM_URL", "https://resource.azure.com/openai/v1")
	if _, _, _, k := localLLMConfig(Config{}); k != "az-test" {
		t.Fatalf("azure url should use AZURE_OPENAI_API_KEY, got %q", k)
	}
}

func TestIsCloudLLM(t *testing.T) {
	for u, want := range map[string]bool{
		"https://openrouter.ai/api/v1": true, "http://127.0.0.1:11434/v1": false, "http://localhost:11434/v1": false,
		"http://192.168.1.20:11434/v1": false, "http://desktop.local:11434/v1": false, "https://api.openai.com/v1": true,
	} {
		if got := isCloudLLM(u); got != want {
			t.Errorf("isCloudLLM(%q) = %v", u, got)
		}
	}
}

func TestOpenRouterFallbacks(t *testing.T) {
	or := "https://openrouter.ai/api/v1"
	got := openRouterFallbacks(or, "baidu/ernie:free", " nvidia/ultra:free, baidu/ernie:free ,x/y:free,z/w:free")
	if want := []string{"baidu/ernie:free", "nvidia/ultra:free", "x/y:free"}; !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if openRouterFallbacks(or, "openrouter/free", "a/b") != nil || openRouterFallbacks("http://127.0.0.1:11434/v1", "m", "a/b") != nil ||
		openRouterFallbacks(or, "m", "") != nil {
		t.Fatal("fallbacks only for a pinned OpenRouter model with a list")
	}
}
