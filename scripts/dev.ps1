param(
    [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Import-DotEnvFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Environment file not found: $Path"
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            continue
        }
        $key = $matches[1]
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $Name"
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

Import-DotEnvFile -Path (Join-Path $repoRoot $EnvFile)
Assert-Command -Name "go"
Assert-Command -Name "pnpm"

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed."
    }
}

$postgres = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($postgres -and $postgres.Status -ne "Running") {
    Start-Service -Name $postgres.Name
    $postgres.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
}

if (Get-NetTCPConnection -State Listen -LocalPort $env:PORT -ErrorAction SilentlyContinue) {
    throw "Backend port $env:PORT is already in use. Stop the existing service first."
}
if (Get-NetTCPConnection -State Listen -LocalPort $env:FRONTEND_PORT -ErrorAction SilentlyContinue) {
    throw "Frontend port $env:FRONTEND_PORT is already in use. Stop the existing service first."
}

Push-Location (Join-Path $repoRoot "server")
try {
    & go run ./cmd/migrate up
    if ($LASTEXITCODE -ne 0) {
        throw "Database migration failed."
    }
} finally {
    Pop-Location
}

$outputDir = Join-Path $repoRoot "output\dev"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$backendOut = Join-Path $outputDir "backend.out.log"
$backendErr = Join-Path $outputDir "backend.err.log"
$frontendOut = Join-Path $outputDir "frontend.out.log"
$frontendErr = Join-Path $outputDir "frontend.err.log"

$goPath = (Get-Command go).Source
$pnpmPath = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpmPath) {
    $pnpmPath = (Get-Command pnpm).Source
}

$backend = Start-Process -FilePath $goPath -ArgumentList @("run", "./cmd/server") `
    -WorkingDirectory (Join-Path $repoRoot "server") -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr
$frontend = Start-Process -FilePath $pnpmPath -ArgumentList @("dev:web") `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr

Write-Host "AI-ME local services are starting."
Write-Host "Frontend: http://localhost:$env:FRONTEND_PORT"
Write-Host "Backend:  http://localhost:$env:PORT"
Write-Host "Logs:     $outputDir"
Write-Host "Press Ctrl+C to stop both services."

try {
    while (-not $backend.HasExited -and -not $frontend.HasExited) {
        Start-Sleep -Seconds 1
        $backend.Refresh()
        $frontend.Refresh()
    }
    if ($backend.HasExited) {
        throw "Backend exited. Check $backendErr"
    }
    throw "Frontend exited. Check $frontendErr"
} finally {
    foreach ($process in @($backend, $frontend)) {
        if ($process -and -not $process.HasExited) {
            Stop-ProcessTree -ProcessId $process.Id
        }
    }
}
