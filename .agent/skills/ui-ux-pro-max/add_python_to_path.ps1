# Add Python to PATH
$pythonPath = "C:\Users\Administrator\AppData\Local\Programs\Python\Python314"
$pythonScriptsPath = "C:\Users\Administrator\AppData\Local\Programs\Python\Python314\Scripts"

Write-Host "============================================================"
Write-Host "Adding Python to PATH"
Write-Host "============================================================"
Write-Host ""

# Get current PATH
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")

# Check if Python is already in PATH
if ($currentPath -like "*$pythonPath*") {
    Write-Host "Python path already exists in PATH" -ForegroundColor Yellow
} else {
    Write-Host "Adding: $pythonPath"
    $newPath = "$currentPath;$pythonPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "  Added!" -ForegroundColor Green
}

# Check if Scripts is already in PATH
if ($currentPath -like "*$pythonScriptsPath*") {
    Write-Host "Scripts path already exists in PATH" -ForegroundColor Yellow
} else {
    Write-Host "Adding: $pythonScriptsPath"
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $newPath = "$currentPath;$pythonScriptsPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "  Added!" -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================================"
Write-Host "PATH Updated Successfully!" -ForegroundColor Green
Write-Host "============================================================"
Write-Host ""
Write-Host "IMPORTANT: You must open a NEW PowerShell window!"
Write-Host ""
Write-Host "After opening a new window, test with:"
Write-Host "  python --version"
Write-Host "  pip --version"
Write-Host ""
