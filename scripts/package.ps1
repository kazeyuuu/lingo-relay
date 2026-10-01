$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$files = @(
    'manifest.json', 'service-worker.js', 'providers.js', 'provider-client.js', 'subscription-client.js', 'response-stream.js',
    'content.js', 'content.css', 'options.html', 'options.js', 'options.css', 'provider-settings.js',
    'popup.html', 'popup.js', 'popup.css', 'shared.css', 'README.md',
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) { throw "Missing package file: $file" }
}
$outputDirectory = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$outputFile = Join-Path $outputDirectory ("lingo-relay-{0}.zip" -f $manifest.version)
# Rebuilding replaces only this version's generated ZIP, never user/browser data.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($outputFile, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $projectRoot $file), $file) | Out-Null
    }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Output $outputFile
