package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
)

// isImageAttachment reports whether an attachment metadata represents an image.
func isImageAttachment(filename, contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if ct != "" {
		switch ct {
		case "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/bmp":
			return true
		}
		if strings.HasPrefix(ct, "image/") {
			return true
		}
	}
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp":
		return true
	}
	return false
}

// downloadTaskImageAttachments downloads image attachments for a task into targetDir
// (or reuses existing local files) and returns their local absolute file paths.
func (d *Daemon) downloadTaskImageAttachments(
	ctx context.Context,
	task Task,
	agentToken string,
	targetDir string,
	taskLog *slog.Logger,
) []string {
	if len(task.ChatMessageAttachments) == 0 {
		return nil
	}

	var toDownload []ChatAttachmentMeta
	for _, att := range task.ChatMessageAttachments {
		if isImageAttachment(att.Filename, att.ContentType) {
			toDownload = append(toDownload, att)
		}
	}
	if len(toDownload) == 0 {
		return nil
	}

	if err := os.MkdirAll(targetDir, 0700); err != nil {
		if taskLog != nil {
			taskLog.Warn("failed to create task attachments directory", "path", targetDir, "error", err)
		}
		return nil
	}

	var imagePaths []string
	for _, att := range toDownload {
		destDir := filepath.Join(targetDir, att.ID)
		destPath := filepath.Join(destDir, att.Filename)

		// Check if already downloaded
		if fi, err := os.Stat(destPath); err == nil && fi.Size() > 0 {
			imagePaths = append(imagePaths, destPath)
			continue
		}

		if d.cfg.ServerBaseURL == "" || agentToken == "" {
			continue
		}

		if err := os.MkdirAll(destDir, 0700); err != nil {
			if taskLog != nil {
				taskLog.Warn("failed to create attachment subdir", "dir", destDir, "error", err)
			}
			continue
		}

		dlCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		client := cli.NewAPIClient(d.cfg.ServerBaseURL, task.WorkspaceID, agentToken)

		var meta map[string]any
		var downloadURL string
		if err := client.GetJSON(dlCtx, "/api/attachments/"+att.ID, &meta); err == nil {
			if u, ok := meta["download_url"].(string); ok && u != "" {
				downloadURL = u
			}
		}
		if downloadURL == "" {
			downloadURL = fmt.Sprintf("/api/attachments/%s/download", att.ID)
		}

		data, err := client.DownloadFile(dlCtx, downloadURL)
		cancel()

		if err != nil {
			if taskLog != nil {
				taskLog.Warn("failed to download task image attachment", "id", att.ID, "filename", att.Filename, "error", err)
			}
			continue
		}

		if err := os.WriteFile(destPath, data, 0600); err != nil {
			if taskLog != nil {
				taskLog.Warn("failed to save task image attachment", "path", destPath, "error", err)
			}
			continue
		}

		imagePaths = append(imagePaths, destPath)
	}

	return imagePaths
}
