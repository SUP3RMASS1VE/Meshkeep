param([string]$Python = 'python', [string]$NpmCli = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $PSScriptRoot
try {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Build this installer on Windows.' }
    $architecture = (& $Python -c "import platform; print(platform.machine().lower())").Trim()
    if ($LASTEXITCODE -ne 0 -or $architecture -notin @('amd64', 'x86_64')) { throw 'This build requires x64 Windows Python.' }
    if ((& node -p 'process.arch').Trim() -ne 'x64') { throw 'This build requires x64 Node.js.' }
    function Check-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)." } }
    & $Python -m venv build/pyenv-win
    Check-Exit 'Create Windows virtual environment'
    $py = Join-Path $PSScriptRoot 'build/pyenv-win/Scripts/python.exe'
    & $py -m pip install --disable-pip-version-check pyinstaller==6.11.1 pillow==11.0.0
    Check-Exit 'Install Python build tools'
    & $py -c "from PIL import Image; Image.open('desktop/build/icon.png').save('desktop/build/icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
    Check-Exit 'Generate Windows icon'
    & $py -m PyInstaller desktop/sidecar.spec --noconfirm --clean --distpath desktop/sidecar-dist-win --workpath build/pyinstaller-win
    Check-Exit 'Build Windows server'
    $previousServer = $env:MME_PACKAGED_SERVER
    try {
        $env:MME_PACKAGED_SERVER = Join-Path $PSScriptRoot 'desktop/sidecar-dist-win/mme-server/mme-server.exe'
        & $py -m unittest discover -s tests -v
        Check-Exit 'Source and packaged server regression tests'
        & node tests/test_slicer.cjs
        Check-Exit 'Native bridge regression tests'
    } finally { $env:MME_PACKAGED_SERVER = $previousServer }
    # Keep copied Mac dependencies and release output intact.
    $stage = Join-Path $PSScriptRoot 'build/windows-desktop'
    New-Item -ItemType Directory -Force -Path "$stage/build" | Out-Null
    Copy-Item desktop/main.js,desktop/preload.js,desktop/package.json,desktop/package-lock.json -Destination $stage -Force
    Copy-Item desktop/build/icon.ico -Destination "$stage/build/icon.ico" -Force
    New-Item -ItemType Directory -Force -Path "$stage/sidecar-dist-win" | Out-Null
    Copy-Item desktop/sidecar-dist-win/mme-server -Destination "$stage/sidecar-dist-win" -Recurse -Force
    if (-not $NpmCli -and -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        $NpmCli = Join-Path $PSScriptRoot 'build/package/bin/npm-cli.js'
        if (-not (Test-Path -LiteralPath $NpmCli)) { throw 'Install Node.js with npm, or pass -NpmCli with the path to npm-cli.js.' }
    }
    Push-Location $stage
    try {
        if ($NpmCli) { & node $NpmCli ci --no-audit --no-fund } else { & npm.cmd ci --no-audit --no-fund }
        Check-Exit 'Install locked Electron dependencies'
        # The builder's archive includes macOS symlinks. Extract only Windows
        # tools so building does not require Windows symlink privileges.
        $env:ELECTRON_BUILDER_CACHE = Join-Path $PSScriptRoot 'build/electron-builder-cache'
        $vendor = Join-Path $env:ELECTRON_BUILDER_CACHE 'winCodeSign/winCodeSign-2.6.0'
        if (-not (Test-Path "$vendor/rcedit-x64.exe")) {
            $archive = Join-Path $PSScriptRoot 'build/winCodeSign-2.6.0.7z'
            Invoke-WebRequest 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' -OutFile $archive
            & node_modules/7zip-bin/win/x64/7za.exe x $archive "-o$vendor" '-xr!darwin' '-xr!linux' -y
            Check-Exit 'Extract Windows resource tools'
        }
        & node node_modules/electron-builder/cli.js --win --x64 --publish never "--config.directories.output=$PSScriptRoot/desktop/dist-win"
        Check-Exit 'Package Windows installer'
    } finally { Pop-Location }
    Get-ChildItem desktop/dist-win/*Setup.exe
} finally { Pop-Location }
