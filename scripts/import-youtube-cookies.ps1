param(
    [Parameter(Mandatory = $true)]
    [string]$CookiesPath
)

$ErrorActionPreference = 'Stop'

$resolved = Resolve-Path -LiteralPath $CookiesPath
$content = Get-Content -LiteralPath $resolved -Raw

if ($content -notmatch 'youtube\.com' -and $content -notmatch 'youtu\.be') {
    throw 'The file does not look like a YouTube cookies.txt export.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
$escaped = $content -replace "`r`n", "\n" -replace "`n", "\n"
$line = "YOUTUBE_COOKIES=$escaped"

if (Test-Path -LiteralPath $envPath) {
    $existing = Get-Content -LiteralPath $envPath -Raw
    if ($existing -match '(?m)^YOUTUBE_COOKIES\s*=') {
        $updated = [regex]::Replace($existing, '(?m)^YOUTUBE_COOKIES\s*=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line })
    } else {
        $suffix = if ($existing.EndsWith("`n")) { '' } else { "`r`n" }
        $updated = "$existing$suffix$line`r`n"
    }
} else {
    $updated = "$line`r`n"
}

Set-Content -LiteralPath $envPath -Value $updated -NoNewline
Write-Host 'Imported YouTube cookies into .env as YOUTUBE_COOKIES.'
