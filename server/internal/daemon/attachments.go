package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
)

var attachmentRegex = regexp.MustCompile(`(?:!\[([^\]]*)\]\([^)]*?/api/attachments/([0-9a-zA-Z_-]+)[^\)]*\)|/api/attachments/([0-9a-zA-Z_-]+))`)

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
	promptText ...string,
) []string {
	var toDownload []ChatAttachmentMeta
	seenIDs := make(map[string]struct{})

	for _, att := range task.ChatMessageAttachments {
		if isImageAttachment(att.Filename, att.ContentType) {
			toDownload = append(toDownload, att)
			seenIDs[att.ID] = struct{}{}
		}
	}

	// Fallback for unpatched servers (e.g. cloud api.multica.ai where
	// ChatMessageAttachments is not populated on task claim for issue comments):
	// scan promptText for markdown attachment links like:
	// ![image.png](https://multica.ai/api/attachments/<UUID>/download) or /api/attachments/<UUID>
	for _, text := range promptText {
		for _, m := range attachmentRegex.FindAllStringSubmatch(text, -1) {
			attID := m[2]
			if attID == "" {
				attID = m[3]
			}
			if attID == "" {
				continue
			}
			if _, seen := seenIDs[attID]; seen {
				continue
			}
			seenIDs[attID] = struct{}{}
			fname := m[1]
			if fname == "" {
				fname = "attachment-" + attID
			}
			toDownload = append(toDownload, ChatAttachmentMeta{
				ID:       attID,
				Filename: fname,
			})
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
		var actualFilename string
		var actualContentType string
		if err := client.GetJSON(dlCtx, "/api/attachments/"+att.ID, &meta); err == nil {
			if u, ok := meta["download_url"].(string); ok && u != "" {
				downloadURL = u
			}
			if fn, ok := meta["filename"].(string); ok && fn != "" {
				actualFilename = fn
			}
			if ct, ok := meta["content_type"].(string); ok && ct != "" {
				actualContentType = ct
			}
		}

		// If metadata lookup succeeded and confirmed file is NOT an image, skip it
		if actualContentType != "" || actualFilename != "" {
			if !isImageAttachment(actualFilename, actualContentType) && !isImageAttachment(att.Filename, att.ContentType) {
				cancel()
				continue
			}
		}
		if actualFilename != "" && actualFilename != att.Filename {
			destPath = filepath.Join(destDir, actualFilename)
			if fi, err := os.Stat(destPath); err == nil && fi.Size() > 0 {
				imagePaths = append(imagePaths, destPath)
				cancel()
				continue
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
