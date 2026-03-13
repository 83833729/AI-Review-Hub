# Python 3.14.2 Installer Download Script
# Downloads the official Python installer

$pythonVersion = "3.14.2"
$downloadUrl = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-amd64.exe"
$outputPath = "$env:USERPROFILE\Desktop\python-$pythonVersion-amd64.exe"

Write-Host "============================================================"
Write-Host "Python $pythonVersion Installer Download"
Write-Host "============================================================"
Write-Host ""
Write-Host "Download URL: $downloadUrl"
Write-Host "Save to: $outputPath"
Write-Host ""
Write-Host "Downloading..." -NoNewline

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $outputPath -UseBasicParsing
    
    Write-Host " Done!" -ForegroundColor Green
    Write-Host ""
    Write-Host "============================================================"
    Write-Host "Download Successful!" -ForegroundColor Green
    Write-Host "============================================================"
    Write-Host ""
    Write-Host "File saved to Desktop:"
    Write-Host "  $outputPath"
    Write-Host ""
    
    $fileInfo = Get-Item $outputPath
    $fileSizeMB = [math]::Round($fileInfo.Length / 1MB, 2)
    Write-Host "File size: $fileSizeMB MB"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Double-click python-$pythonVersion-amd64.exe on your Desktop"
    Write-Host "  2. Check 'Add Python to PATH'"
    Write-Host "  3. Click 'Install Now'"
    Write-Host ""
}
catch {
    Write-Host " Failed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host ""
    Write-Host "Alternative: Download manually from:"
    Write-Host $downloadUrl
}

