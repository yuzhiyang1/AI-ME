package execenv

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func writeMulticaWrapper(binDir string) error {
	if binDir == "" {
		return nil
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe = strings.ReplaceAll(exe, "'", "''")
	content := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$global:OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$exe = '%s'
if ($MyInvocation.ExpectingInput) {
    $input | & $exe @args
} else {
    & $exe @args
}
exit $LASTEXITCODE
`, exe)
	return os.WriteFile(filepath.Join(binDir, "multica.ps1"), []byte(content), 0o644)
}
