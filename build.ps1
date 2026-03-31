# 1. Initialize Submodules and Build Server
Write-Host "--- Initializing Submodules and Building Server ---" -ForegroundColor Cyan

# Use Push-Location / Pop-Location to ensure we always return to root
Push-Location "server/3rd/luamake"
cmd /c "compile\build.bat"
Pop-Location

$luamakePath = ".\server\3rd\luamake\luamake.exe"
$buildArgs = if ($args.Count -eq 0) { "rebuild" } else { "rebuild --platform $($args[0])" }

Write-Host "Launching build in new window..." -ForegroundColor Yellow

# Updated logic: Use -NoExit if the build fails so you can read the error
$scriptBlock = @"
    Set-Location -Path 'server'
    & '.\3rd\luamake\luamake.exe' `$buildArgs
    if (`$LASTEXITCODE -ne 0) {
        Write-Host "`nBuild failed! Press any key to close this window..." -ForegroundColor Red
        pause
        exit `$LASTEXITCODE
    }
"@

$process = Start-Process powershell -ArgumentList "-NoProfile", "-Command", $scriptBlock -Wait -PassThru

if ($process.ExitCode -ne 0) {
    Write-Error "Build failed in the external window with Exit Code: $($process.ExitCode)"
    exit $process.ExitCode
}

# 2. Build Client
Write-Host "`n--- Building VS Code Extension Client ---" -ForegroundColor Cyan
Push-Location "client"
pnpm install
pnpm run build
Pop-Location

# 3. Prepare Publish Directory
Write-Host "`n--- Preparing Distribution Folder ---" -ForegroundColor Cyan
if (!(Test-Path "package.json")) { Write-Error "Root package.json not found!"; exit 1 }

$packageJson = Get-Content "package.json" | ConvertFrom-Json
$version = $packageJson.version
$publishDir = "publish/test"

if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }
New-Item -ItemType Directory -Path $publishDir | Out-Null

# Update README to use PNGs instead of SVGs for VS Code marketplace compatibility
if (Test-Path "server/README.md") {
    $readmeContent = Get-Content "server/README.md"
    $readmeContent -replace '\.svg', '.png' | Set-Content "README.md"
}

# 4. Copy Files to Staging
Write-Host "Copying files to $publishDir..." -ForegroundColor Yellow

$includeList = @(
    "LICENSE", "client/node_modules", "client/out", "client/package.json",
    "client/3rd/vscode-lua-doc/doc", "client/3rd/vscode-lua-doc/extension.js",
    "client/web", "server/bin", "server/doc", "server/locale", "server/script",
    "server/main.lua", "server/debugger.lua", "server/meta/template",
    "server/meta/3rd", "server/meta/spell", "images/logo.png", "syntaxes",
    "package.json", "README.md", "package.nls.json"
)

foreach ($item in $includeList) {
    $source = Join-Path $PSScriptRoot $item
    $destination = Join-Path $publishDir $item

    if (Test-Path $source) {
        $parent = Split-Path $destination
        if (!(Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
        Copy-Item -Path $source -Destination $destination -Recurse -Force
    }
}

# 5. Cleanup
$cleanupList = @("server/log", "server/meta/Lua 5.4 zh-cn")
foreach ($item in $cleanupList) {
    $path = Join-Path $publishDir $item
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}

# 6. Package VSIX
Write-Host "`n--- Packaging VSIX ---" -ForegroundColor Cyan
if (Get-Command vsce -ErrorAction SilentlyContinue) {
    $vsixName = "lua-$version.vsix"
    Push-Location $publishDir
    # Use npx in case vsce is only local, or call global
    vsce package -o "../../$vsixName"
    Pop-Location
    Write-Host "Successfully created $vsixName" -ForegroundColor Green
} else {
    Write-Error "vsce command not found. Run: pnpm install -g @vscode/vsce"
}