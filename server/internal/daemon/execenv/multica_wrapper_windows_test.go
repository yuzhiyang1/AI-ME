//go:build windows

package execenv

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMulticaWrapperPreservesPowerShellPipelineUTF8(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	if err := writeMulticaWrapper(dir); err != nil {
		t.Fatalf("writeMulticaWrapper: %v", err)
	}

	helper := filepath.Join(dir, "stdin-helper.go")
	if err := os.WriteFile(helper, []byte(`package main
import (
	"io"
	"os"
)
func main() {
	b, _ := io.ReadAll(os.Stdin)
	_, _ = os.Stdout.Write(b)
}
`), 0o600); err != nil {
		t.Fatalf("write helper source: %v", err)
	}
	helperExe := filepath.Join(dir, "multica-real.exe")
	buildGoHelper(t, helperExe, helper)
	patchWrapperExecutable(t, filepath.Join(dir, "multica.ps1"), helperExe)

	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "'"+chineseText()+"' | & "+shellQuotePowerShell(filepath.Join(dir, "multica.ps1")))
	cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run wrapper: %v\n%s", err, out)
	}
	got := strings.TrimPrefix(strings.TrimSpace(string(out)), "\ufeff")
	want := chineseText()
	if got != want {
		t.Fatalf("pipeline text = %q, want %q; raw bytes=% x", got, want, out)
	}
}

func TestMulticaWrapperPreservesPowerShellNativeOutputPipelineUTF8(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	if err := writeMulticaWrapper(dir); err != nil {
		t.Fatalf("writeMulticaWrapper: %v", err)
	}

	helper := filepath.Join(dir, "stdout-helper.go")
	if err := os.WriteFile(helper, []byte(`package main
import "fmt"
func main() {
	fmt.Println("`+chineseText()+`")
}
`), 0o600); err != nil {
		t.Fatalf("write helper source: %v", err)
	}
	helperExe := filepath.Join(dir, "multica-real.exe")
	buildGoHelper(t, helperExe, helper)
	patchWrapperExecutable(t, filepath.Join(dir, "multica.ps1"), helperExe)

	probe := filepath.Join(dir, "probe.js")
	if err := os.WriteFile(probe, []byte(`const chunks = [];
process.stdin.on('data', b => chunks.push(b));
process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('utf8')));
`), 0o600); err != nil {
		t.Fatalf("write probe: %v", err)
	}

	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& "+shellQuotePowerShell(filepath.Join(dir, "multica.ps1"))+" | node "+shellQuotePowerShell(probe))
	cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run wrapper output pipeline: %v\n%s", err, out)
	}
	got := strings.TrimPrefix(strings.TrimSpace(string(out)), "\ufeff")
	want := chineseText()
	if got != want {
		t.Fatalf("output pipeline text = %q, want %q; raw bytes=% x", got, want, out)
	}
}

func buildGoHelper(t *testing.T, output string, source string) {
	t.Helper()
	build := exec.Command("go", "build", "-o", output, source)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v\n%s", err, out)
	}
}

func patchWrapperExecutable(t *testing.T, wrapper string, helperExe string) {
	t.Helper()
	content, err := os.ReadFile(wrapper)
	if err != nil {
		t.Fatalf("read wrapper: %v", err)
	}
	content = []byte(strings.Replace(string(content), os.Args[0], helperExe, 1))
	if err := os.WriteFile(wrapper, content, 0o600); err != nil {
		t.Fatalf("patch wrapper: %v", err)
	}
}

func shellQuotePowerShell(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func chineseText() string {
	return "\u7edf\u8ba1\u5de5\u4f5c\u7a7a\u95f4\u4e2d\u7684\u5065\u8eab\u7b14\u8bb0\u6570\u91cf"
}
