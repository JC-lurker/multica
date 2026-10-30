package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var browserCmd = &cobra.Command{
	Use:   "browser",
	Short: "Drive the issue's browser panel in Multica desktop",
	Long: `Drive the per-issue browser panel of the Multica desktop app.

Run "snapshot" first: it lists the page's interactive elements with @eN refs,
which click and type take. Refs go stale when the page navigates; snapshot
again after goto or any click that loads a new page.

Requires the desktop app to be running with the issue's Browser panel open.`,
}

var browserSnapshotCmd = &cobra.Command{
	Use:   "snapshot",
	Short: "List interactive elements with @eN refs",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		scope, _ := cmd.Flags().GetString("scope")
		body := map[string]any{}
		if scope != "" {
			body["scope"] = scope
		}
		return runBrowser(cmd, "snapshot", body)
	},
}

var browserWaitCmd = &cobra.Command{
	Use:   "wait",
	Short: "Wait until the page contains text or its URL contains a substring",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		text, _ := cmd.Flags().GetString("text")
		url, _ := cmd.Flags().GetString("url")
		if (text == "") == (url == "") {
			return errors.New("pass exactly one of --text or --url")
		}
		timeout, _ := cmd.Flags().GetDuration("timeout")
		return runBrowser(cmd, "wait", map[string]any{"text": text, "url": url, "timeout_ms": timeout.Milliseconds()})
	},
}

var browserShotCmd = &cobra.Command{
	Use:   "shot [@ref]",
	Short: "Save a downscaled (<=1024px) JPEG screenshot of the page or an element",
	Long: `Save a screenshot and print its path. Without a ref the visible page is captured;
@ref may be an element from the latest snapshot or @picked (the element the user
picked in the Browser panel).`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		body := map[string]any{}
		if len(args) == 1 {
			body["ref"] = args[0]
		}
		return runBrowser(cmd, "shot", body)
	},
}

var browserClickCmd = &cobra.Command{
	Use:   "click <@ref>",
	Short: "Click an element from the latest snapshot",
	Args:  exactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runBrowser(cmd, "click", map[string]any{"ref": args[0]})
	},
}

var browserTypeCmd = &cobra.Command{
	Use:   "type <@ref> <text>",
	Short: "Type text into an element from the latest snapshot",
	Args:  exactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		clear, _ := cmd.Flags().GetBool("clear")
		submit, _ := cmd.Flags().GetBool("submit")
		return runBrowser(cmd, "type", map[string]any{
			"ref": args[0], "text": args[1], "clear": clear, "submit": submit,
		})
	},
}

var browserGotoCmd = &cobra.Command{
	Use:   "goto <url>",
	Short: "Navigate to an http(s) URL",
	Args:  exactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runBrowser(cmd, "goto", map[string]any{"url": args[0]})
	},
}

var browserStateCmd = &cobra.Command{
	Use:   "state",
	Short: "Show the current URL, title and loading state",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		return runBrowser(cmd, "state", nil)
	},
}

func init() {
	browserCmd.PersistentFlags().String("issue", "", "Issue key (MUL-123) or UUID whose browser to drive")
	_ = browserCmd.MarkPersistentFlagRequired("issue")
	browserTypeCmd.Flags().Bool("clear", false, "Select existing content first so it is replaced")
	browserTypeCmd.Flags().Bool("submit", false, "Press Enter after typing")
	browserSnapshotCmd.Flags().String("scope", "", "Only list elements under this @ref (use when the snapshot is truncated)")
	browserWaitCmd.Flags().String("text", "", "Wait for the page to contain this text")
	browserWaitCmd.Flags().String("url", "", "Wait for the URL to contain this substring")
	browserWaitCmd.Flags().Duration("timeout", 10*time.Second, "Give up after this long (max 25s)")
	browserShotCmd.Flags().String("out", "", "Write the JPEG here (default: a temp file)")
	browserCmd.AddCommand(browserSnapshotCmd, browserClickCmd, browserTypeCmd, browserGotoCmd, browserWaitCmd, browserShotCmd, browserStateCmd)
}

// browserBridgeFile is what the desktop app writes at startup. It lives under
// the real home directory, not the task-local config root, because the app
// that owns it runs outside the task sandbox.
type browserBridgeFile struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func browserBridgeFilePath() (string, error) {
	if p := os.Getenv("MULTICA_BROWSER_BRIDGE_FILE"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".multica", "browser-bridge.json"), nil
}

var errDesktopNotRunning = errors.New("Multica desktop is not running (or too old to support browser control); start the desktop app and open the issue's Browser panel")

func loadBrowserBridge(path string) (browserBridgeFile, error) {
	var f browserBridgeFile
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return f, errDesktopNotRunning
		}
		return f, err
	}
	if err := json.Unmarshal(data, &f); err != nil || f.Port == 0 || f.Token == "" {
		return f, errDesktopNotRunning
	}
	return f, nil
}

// callBrowserBridge posts one action and returns the decoded response body.
func callBrowserBridge(ctx context.Context, bridge browserBridgeFile, action string, body map[string]any) (map[string]any, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/v1/%s", bridge.Port, action)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+bridge.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// A stale bridge file (app crashed) refuses connections.
		return nil, errDesktopNotRunning
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("browser bridge returned HTTP %d", resp.StatusCode)
	}
	if ok, _ := out["ok"].(bool); !ok {
		msg, _ := out["error"].(string)
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return nil, errors.New(msg)
	}
	return out, nil
}

func writeBrowserShot(cmd *cobra.Command, b64 string) error {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return fmt.Errorf("decode screenshot: %w", err)
	}
	path, _ := cmd.Flags().GetString("out")
	if path == "" {
		f, err := os.CreateTemp("", "multica-shot-*.jpg")
		if err != nil {
			return err
		}
		path = f.Name()
		f.Close()
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), path)
	return nil
}

func runBrowser(cmd *cobra.Command, action string, body map[string]any) error {
	path, err := browserBridgeFilePath()
	if err != nil {
		return err
	}
	bridge, err := loadBrowserBridge(path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	issueRef, _ := cmd.Flags().GetString("issue")
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	issue, err := resolveIssueRef(ctx, client, issueRef)
	if err != nil {
		return err
	}
	if body == nil {
		body = map[string]any{}
	}
	body["issue"] = issue.ID

	out, err := callBrowserBridge(ctx, bridge, action, body)
	if err != nil {
		return err
	}
	if snap, ok := out["snapshot"].(string); ok {
		fmt.Fprintln(cmd.OutOrStdout(), snap)
		return nil
	}
	if jpeg, ok := out["jpeg"].(string); ok {
		return writeBrowserShot(cmd, jpeg)
	}
	if diff, ok := out["diff"].(string); ok {
		fmt.Fprintln(cmd.OutOrStdout(), diff)
		return nil
	}
	if state, ok := out["state"]; ok {
		return cli.PrintJSON(cmd.OutOrStdout(), state)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "ok")
	return nil
}
