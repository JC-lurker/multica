package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func bridgeFor(t *testing.T, srv *httptest.Server, token string) browserBridgeFile {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	return browserBridgeFile{Port: port, Token: token}
}

func TestCallBrowserBridgeSendsTokenAndBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Path != "/v1/click" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"error":"unauthorized"}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["ref"] != "@e1" {
			t.Errorf("body = %v", body)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	if _, err := callBrowserBridge(context.Background(), bridgeFor(t, srv, "tok"), "click", map[string]any{"ref": "@e1"}); err != nil {
		t.Fatalf("authorized call: %v", err)
	}
	_, err := callBrowserBridge(context.Background(), bridgeFor(t, srv, "bad"), "click", nil)
	if err == nil || err.Error() != "unauthorized" {
		t.Fatalf("wrong token err = %v", err)
	}
}

func TestCallBrowserBridgeSurfacesStaleRef(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"ok":false,"error":"stale ref: page changed"}`))
	}))
	defer srv.Close()
	_, err := callBrowserBridge(context.Background(), bridgeFor(t, srv, "t"), "click", nil)
	if err == nil || !strings.Contains(err.Error(), "stale ref") {
		t.Fatalf("err = %v", err)
	}
}

func TestBrowserBridgeUnavailableIsClear(t *testing.T) {
	if _, err := loadBrowserBridge(filepath.Join(t.TempDir(), "missing.json")); err != errDesktopNotRunning {
		t.Fatalf("missing file err = %v", err)
	}
	// Stale file: nothing listening on the recorded port.
	srv := httptest.NewServer(http.NotFoundHandler())
	b := bridgeFor(t, srv, "t")
	srv.Close()
	if _, err := callBrowserBridge(context.Background(), b, "state", nil); err != errDesktopNotRunning {
		t.Fatalf("stale file err = %v", err)
	}
	bad := filepath.Join(t.TempDir(), "b.json")
	_ = os.WriteFile(bad, []byte(`{}`), 0o600)
	if _, err := loadBrowserBridge(bad); err != errDesktopNotRunning {
		t.Fatalf("empty file err = %v", err)
	}
}
