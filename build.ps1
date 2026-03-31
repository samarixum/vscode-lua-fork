# 1. Initialize Submodules and Build Server
Write-Host "--- Initializing Submodules and Building Server ---" -ForegroundColor Cyan

# Updated path to submodules/server
$serverPath = Join-Path $PSScriptRoot "submodules/server"

if (Test-Path $serverPath) {
    # 1. Build luamake (Dependency)
    # Using Push/Pop to ensure we don't lose our place in the folder structure
    Push-Location (Join-Path $serverPath "submodules/luamake")

    if (Test-Path "compile\build.bat") {
        Write-Host "Building luamake..." -ForegroundColor Gray
        cmd /c "compile\build.bat"
    } else {
        Write-Warning "luamake build script not found. Skipping submodule initialization."
    }
    Pop-Location

    # 2. Configure Build Arguments
    $luamakeExe = Join-Path $serverPath "submodules/luamake/luamake.exe"

    # Ensure arguments are a clean array of strings
    $buildArgs = if ($args.Count -eq 0) {
        @("rebuild")
    } else {
        @("rebuild", "--platform", "$($args[0])")
    }

    # 3. Execute Build in the Current Window
    if (Test-Path $luamakeExe) {
        Write-Host "Starting build in current session..." -ForegroundColor Yellow

        Push-Location $serverPath

        # Use --% (stop-parsing symbol) if the call operator still struggles,
        # but a clean array usually fixes the "r" vs "rebuild" issue.
        & $luamakeExe $buildArgs

        $lastExit = $LASTEXITCODE
        Pop-Location

        if ($lastExit -ne 0) {
            Write-Error "Build failed with Exit Code: $lastExit"
            exit $lastExit
        }

        Write-Host "Build completed successfully!" -ForegroundColor Green
    } else {
        Write-Error "luamake.exe not found at $luamakeExe"
        exit 1
    }
} else {
    Write-Warning "Server directory not found at $serverPath. Skipping server build."
}

# 2. Build Client
Write-Host "`n--- Building VS Code Extension Client ---" -ForegroundColor Cyan
# Updated path to submodules/client
Push-Location "submodules/client"
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

# Update README using server path in submodules
if (Test-Path "submodules/server/README.md") {
    $readmeContent = Get-Content "submodules/server/README.md"
    $readmeContent -replace '\.svg', '.png' | Set-Content "README.md"
}

# 4. Copy Files to Staging
Write-Host "Copying files to $publishDir..." -ForegroundColor Yellow

# Updated list reflecting submodules folder and new vscode-lua-doc location
$includeList = @(
    "LICENSE",
    "submodules/client/node_modules",
    "submodules/client/out",
    "submodules/client/package.json",
    "submodules/vscode-lua-doc/doc",
    "submodules/vscode-lua-doc/extension.js",
    "submodules/client/web",
    "submodules/server/bin",
    "submodules/server/doc",
    "submodules/server/locale",
    "submodules/server/script",
    "submodules/server/main.lua",
    "submodules/server/debugger.lua",
    "submodules/server/meta/template",
    "submodules/server/meta/submodules",
    "submodules/server/meta/spell",
    "images/logo.png",
    "syntaxes",
    "package.json",
    "README.md",
    "package.nls.json"
)

foreach ($item in $includeList) {
    $source = Join-Path $PSScriptRoot $item

    # We strip the "submodules/" prefix for the destination so the VSIX internal structure
    # remains clean (e.g., submodules/server/bin becomes server/bin in the package)
    $cleanDest = $item -replace '^submodules/', ''
    $destination = Join-Path $publishDir $cleanDest

    if (Test-Path $source) {
        $parent = Split-Path $destination
        if (!(Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
        Copy-Item -Path $source -Destination $destination -Recurse -Force
    }
}

# 5. Cleanup
# Updated cleanup paths to match stripped destination paths
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
    vsce package -o "../../$vsixName"
    Pop-Location
    Write-Host "Successfully created $vsixName" -ForegroundColor Green
} else {
    Write-Error "vsce command not found. Run: pnpm install -g @vscode/vsce"
}