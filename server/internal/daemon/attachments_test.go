package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestIsImageAttachment(t *testing.T) {
	tests := []struct {
		filename    string
		contentType string
		want        bool
	}{
		{"photo.png", "image/png", true},
		{"photo.jpg", "image/jpeg", true},
		{"photo.JPEG", "", true},
		{"photo.webp", "application/octet-stream", true},
		{"anim.gif", "image/gif", true},
		{"bitmap.bmp", "image/bmp", true},
		{"vector.svg", "image/svg+xml", true},
		{"doc.pdf", "application/pdf", false},
		{"doc.txt", "text/plain", false},
		{"script.sh", "", false},
		{"archive.tar.gz", "application/gzip", false},
	}

	for _, tt := range tests {
		got := isImageAttachment(tt.filename, tt.contentType)
		if got != tt.want {
			t.Errorf("isImageAttachment(%q, %q) = %v, want %v", tt.filename, tt.contentType, got, tt.want)
		}
	}
}

func TestDownloadTaskImageAttachments(t *testing.T) {
	fakeImgBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

	downloadCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/attachments/att-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"download_url": "/api/attachments/att-1/download",
			})
		case "/api/attachments/att-1/download":
			downloadCount++
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(fakeImgBytes)
		case "/api/attachments/att-fail":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"download_url": "/api/attachments/att-fail/download",
			})
		case "/api/attachments/att-fail/download":
			http.Error(w, "internal server error", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	d := &Daemon{
		cfg: Config{
			ServerBaseURL: server.URL,
		},
	}

	targetDir := t.TempDir()

	t.Run("empty attachments", func(t *testing.T) {
		got := d.downloadTaskImageAttachments(context.Background(), Task{}, "tok", targetDir, slog.Default())
		if len(got) != 0 {
			t.Errorf("expected 0 image attachments, got: %v", got)
		}
	})

	t.Run("skips non-images", func(t *testing.T) {
		task := Task{
			ChatMessageAttachments: []ChatAttachmentMeta{
				{ID: "att-txt", Filename: "notes.txt", ContentType: "text/plain"},
			},
		}
		got := d.downloadTaskImageAttachments(context.Background(), task, "tok", targetDir, slog.Default())
		if len(got) != 0 {
			t.Errorf("expected 0 image attachments for text file, got: %v", got)
		}
	})

	t.Run("downloads image and caches locally", func(t *testing.T) {
		task := Task{
			WorkspaceID: "ws-1",
			ChatMessageAttachments: []ChatAttachmentMeta{
				{ID: "att-1", Filename: "screenshot.png", ContentType: "image/png"},
			},
		}

		paths := d.downloadTaskImageAttachments(context.Background(), task, "tok", targetDir, slog.Default())
		if len(paths) != 1 {
			t.Fatalf("expected 1 image path, got: %v", paths)
		}

		expectedPath := filepath.Join(targetDir, "att-1", "screenshot.png")
		if paths[0] != expectedPath {
			t.Errorf("got path %q, want %q", paths[0], expectedPath)
		}

		data, err := os.ReadFile(expectedPath)
		if err != nil {
			t.Fatalf("failed to read downloaded file: %v", err)
		}
		if string(data) != string(fakeImgBytes) {
			t.Errorf("file content mismatch: got %v, want %v", data, fakeImgBytes)
		}

		if downloadCount != 1 {
			t.Fatalf("downloadCount = %d, want 1", downloadCount)
		}

		// Re-run should reuse existing cached file without downloading again
		pathsCached := d.downloadTaskImageAttachments(context.Background(), task, "tok", targetDir, slog.Default())
		if len(pathsCached) != 1 || pathsCached[0] != expectedPath {
			t.Errorf("cached run got: %v, want %v", pathsCached, expectedPath)
		}
		if downloadCount != 1 {
			t.Errorf("downloadCount increased to %d, expected reuse from disk", downloadCount)
		}
	})

	t.Run("download failure does not fail execution", func(t *testing.T) {
		task := Task{
			WorkspaceID: "ws-1",
			ChatMessageAttachments: []ChatAttachmentMeta{
				{ID: "att-fail", Filename: "broken.png", ContentType: "image/png"},
			},
		}

		paths := d.downloadTaskImageAttachments(context.Background(), task, "tok", targetDir, slog.Default())
		if len(paths) != 0 {
			t.Errorf("expected 0 paths on failure, got: %v", paths)
		}
	})

	t.Run("extracts image attachment URLs from prompt text fallback", func(t *testing.T) {
		promptWithImg := "Hello please check this out:\n\n![diagram.png](https://api.multica.ai/api/attachments/att-1/download)"
		paths := d.downloadTaskImageAttachments(context.Background(), Task{WorkspaceID: "ws-1"}, "tok", targetDir, slog.Default(), promptWithImg)
		if len(paths) != 1 {
			t.Fatalf("expected 1 image path extracted from prompt, got: %v", paths)
		}
	})
}
