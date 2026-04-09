param(
    [string]$Mode = ""
)

$isAuto = ($Mode -eq "auto")

# 1. Initialize Submodules and Build Server
Write-Host "--- Initializing Submodules and Building Server ---" -ForegroundColor Cyan

# Updated path to submodules/server
$serverPath = Join-Path $PSScriptRoot "submodules/server"
$serverExe = Join-Path $serverPath "bin/lua-language-server.exe"
$buildServer = $true

if (Test-Path $serverExe) {
    if ($isAuto) {
        Write-Host "Auto mode detected: dont rebuilding server." -ForegroundColor Yellow
        $buildServer = $false
    } else {
        Write-Host "Existing server executable found at $serverExe." -ForegroundColor Yellow

        $choice = Read-Host "Rebuild the server? [r]ebuild / [s]kip (default: skip)"
        if ([string]::IsNullOrWhiteSpace($choice)) {
            $choice = "s"
        }

        switch ($choice.Trim().ToLowerInvariant()) {
            "r" { $buildServer = $true }
            "rebuild" { $buildServer = $true }
            "s" { $buildServer = $false }
            "skip" { $buildServer = $false }
            default {
                Write-Warning "Unrecognized choice '$choice'. Skipping server rebuild."
                $buildServer = $false
            }
        }
    }
}

if (Test-Path $serverPath) {
    if ($buildServer) {
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
        Write-Host "Skipping server rebuild at user request." -ForegroundColor Yellow
    }
} else {
    Write-Warning "Server directory not found at $serverPath. Skipping server build."
}

# 2. Build Client
Write-Host "`n--- Building VS Code Extension Client ---" -ForegroundColor Cyan
# Updated path to submodules/client
Push-Location "submodules/client"
pnpm install
pnpm run prod
Pop-Location



# 3. Prepare Publish Directory
Write-Host "`n--- Preparing Distribution Folder ---" -ForegroundColor Cyan

$clientPackageJson = Join-Path $PSScriptRoot "submodules/client/package.json"
if (!(Test-Path $clientPackageJson)) { Write-Error "Client package.json not found!"; exit 1 }

$packageJson = Get-Content -Raw $clientPackageJson | ConvertFrom-Json
$version = $packageJson.version
$extensionPackageJson = [ordered]@{}
$packageJson.PSObject.Properties | ForEach-Object { $extensionPackageJson[$_.Name] = $_.Value }
foreach ($field in @("type", "scripts", "dependencies", "devDependencies")) {
    if ($extensionPackageJson.Contains($field)) {
        $extensionPackageJson.Remove($field)
    }
}
# temp output folder
$publishDir = "Build/TMP"

if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }
New-Item -ItemType Directory -Path $publishDir | Out-Null


# 4. Build Localisation Files
Write-Host "`n--- Building Localisation Files ---" -ForegroundColor Cyan
$buildScript = ".\build-settings.lua"

if (Test-Path $serverExe) {
    Write-Host "Running $buildScript..." -ForegroundColor Gray
    & $serverExe $buildScript
    if ($LASTEXITCODE -ne 0) { Write-Error "Localisation build failed!"; exit $LASTEXITCODE }
}

# 5. Copy Files to Staging
Write-Host "Copying files to $publishDir..." -ForegroundColor Yellow

# Define mapping: "SourcePath" = "DestinationPathRelative"
# Using a hashtable for explicit control over the internal VSIX structure
$itemsToCopy = @{
    "submodules/client/LICENSE"             = "LICENSE"
    "submodules/client/package.json"        = "package.json"
    "submodules/client/README.md"           = "README.md"
    "submodules/client/resources"           = "resources"
    "submodules/client/dist"                = "dist"


    "setting" = "setting"

    # Server Structure
    "submodules/server/bin"                 = "server/bin"
    "submodules/server/doc"                 = "server/doc"
    "submodules/server/locale"              = "server/locale"
    "submodules/server/script"              = "server/script"
    "submodules/server/main.lua"            = "server/main.lua"
    "submodules/server/debugger.lua"        = "server/debugger.lua"
    "submodules/server/test"                = "server/test"
    "submodules/server/test.lua"            = "server/test.lua"
    "submodules/server/changelog.md"        = "server/changelog.md"
    "submodules/server/meta/template"       = "server/meta/template"
    "submodules/server/meta/submodules"     = "server/meta/3rd"
    "submodules/server/meta/spell"          = "server/meta/spell"
}

# 1. Copy explicit items
foreach ($entry in $itemsToCopy.GetEnumerator()) {
    $src = Join-Path $PSScriptRoot $entry.Key
    $dest = Join-Path $publishDir $entry.Value

    if (Test-Path $src) {
        $parent = Split-Path $dest
        if (!(Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
        Copy-Item -Path $src -Destination $dest -Recurse -Force
    }
}

# Keep a copy of the client manifest alongside the client build output.
Copy-Item -Path $clientPackageJson -Destination (Join-Path $publishDir "package.json") -Force

# 2. Copy Localisation Files (Wildcard to catch all generated languages)
Get-ChildItem -Path $PSScriptRoot -Filter "package.nls*.json" | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $publishDir -Force
}

# 3. Copy Syntaxes (Try to find it in client if not in root)
#$syntaxPath = if (Test-Path "syntaxes") { "syntaxes" } else { "submodules/client/syntaxes" }
#if (Test-Path $syntaxPath) {
#    Copy-Item -Path $syntaxPath -Destination (Join-Path $publishDir "syntaxes") -Recurse -Force
#}

# 4. Handle Server's meta/3rd directory
# If the server build uses its own 3rd party meta, ensure it exists
$meta3rd = Join-Path $publishDir "server/meta/3rd"
if (!(Test-Path $meta3rd)) { New-Item -ItemType Directory -Path $meta3rd | Out-Null }

# Rewrite staged package manifest
$extensionPackageJson | ConvertTo-Json -Depth 100 | Set-Content (Join-Path $publishDir "package.json")

# 6. Cleanup
$cleanupList = @("server/log", "server/meta/Lua 5.4 zh-cn")
foreach ($item in $cleanupList) {
    $path = Join-Path $publishDir $item
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}

# 7. Package VSIX
if (-not $isAuto) {
    Write-Host "`n--- Packaging VSIX ---" -ForegroundColor Cyan
    if (Get-Command vsce -ErrorAction SilentlyContinue) {
        $vsixName = "lua-$version.vsix"
        Push-Location $publishDir
        vsce package -o "../../$vsixName"
        Pop-Location
        Write-Host "Successfully created $vsixName" -ForegroundColor Green
    }
} else {
    Write-Host "`n--- Skipping VSIX Packaging (Auto Mode) ---" -ForegroundColor Yellow
}

