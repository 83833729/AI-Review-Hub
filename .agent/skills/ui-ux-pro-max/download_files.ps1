# UI/UX Pro Max Skill - File Downloader (PowerShell)
$baseUrl = "https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/.shared/ui-ux-pro-max"
$skillDir = "c:\Users\Administrator\Desktop\Antigravity-admin\.agent\skills\ui-ux-pro-max"

# File lists
$scripts = @(
    "scripts/search.py",
    "scripts/core.py",
    "scripts/design_system.py"
)

$dataFiles = @(
    "data/charts.csv",
    "data/colors.csv",
    "data/icons.csv",
    "data/landing.csv",
    "data/products.csv",
    "data/prompts.csv",
    "data/react-performance.csv",
    "data/styles.csv",
    "data/typography.csv",
    "data/ui-reasoning.csv",
    "data/ux-guidelines.csv",
    "data/web-interface.csv"
)

$stackFiles = @(
    "data/stacks/flutter.csv",
    "data/stacks/html-tailwind.csv",
    "data/stacks/jetpack-compose.csv",
    "data/stacks/nextjs.csv",
    "data/stacks/nuxt-ui.csv",
    "data/stacks/nuxtjs.csv",
    "data/stacks/react-native.csv",
    "data/stacks/react.csv",
    "data/stacks/shadcn.csv",
    "data/stacks/svelte.csv",
    "data/stacks/swiftui.csv",
    "data/stacks/vue.csv"
)

function Download-File {
    param($url, $dest)
    try {
        $destDir = Split-Path -Parent $dest
        if (!(Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        $fileName = Split-Path -Leaf $dest
        Write-Host "Downloading: $fileName..." -NoNewline
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        Write-Host " Success" -ForegroundColor Green
        return $true
    }
    catch {
        Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

Write-Host "============================================================"
Write-Host "UI/UX Pro Max Skill - File Downloader"
Write-Host "============================================================"

$downloaded = 0
$failed = 0

Write-Host ""
Write-Host "Python Scripts:"
Write-Host "------------------------------------------------------------"
foreach ($file in $scripts) {
    $url = "$baseUrl/$file"
    $dest = Join-Path $skillDir $file
    if (Download-File $url $dest) { $downloaded++ } else { $failed++ }
}

Write-Host ""
Write-Host "Core Data Files:"
Write-Host "------------------------------------------------------------"
foreach ($file in $dataFiles) {
    $url = "$baseUrl/$file"
    $dest = Join-Path $skillDir $file
    if (Download-File $url $dest) { $downloaded++ } else { $failed++ }
}

Write-Host ""
Write-Host "Stack Files:"
Write-Host "------------------------------------------------------------"
foreach ($file in $stackFiles) {
    $url = "$baseUrl/$file"
    $dest = Join-Path $skillDir $file
    if (Download-File $url $dest) { $downloaded++ } else { $failed++ }
}

$total = $scripts.Count + $dataFiles.Count + $stackFiles.Count
Write-Host ""
Write-Host "============================================================"
Write-Host "Download Complete!"
Write-Host "  Success: $downloaded/$total"
if ($failed -gt 0) {
    Write-Host "  Failed: $failed/$total" -ForegroundColor Red
}
Write-Host "============================================================"
