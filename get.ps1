# Jarvis one-line installer for Windows 10 and 11 (stock Windows PowerShell 5.1 and the built-in curl.exe).
#
#   curl.exe -fsSL https://raw.githubusercontent.com/EricTechPro/jarvis/main/get.ps1 | powershell -NoProfile -ExecutionPolicy Bypass -Command -
#
# Downloads the latest release's installer, runs it silently (per user, no admin prompt) and opens Jarvis.
# Use curl.exe, not curl: in Windows PowerShell 5.1, curl is an alias for Invoke-WebRequest.
#
# Environment:
#   JARVIS_VERSION   install that release (for example v0.2.0) instead of the latest
#   JARVIS_REPO      GitHub owner/repo to download from (default EricTechPro/jarvis)
#   JARVIS_URL       exact installer URL to use instead
#   JARVIS_NO_OPEN   set to 1 to install without starting Jarvis
#
# Read from stdin, PowerShell runs each complete statement as soon as it has it, so everything sits in one
# script block that closes on the last line: a download cut off halfway through runs nothing. Keep this file
# ASCII; Windows PowerShell reads piped text in the console code page.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # Keep in step with the "Attach to a draft release" step in .github/workflows/release.yml.
  $name = 'Jarvis-windows-x64-setup.exe'
  $repo = if ($env:JARVIS_REPO) { $env:JARVIS_REPO } else { 'EricTechPro/jarvis' }
  $url = $env:JARVIS_URL
  if (-not $url) {
    if ($env:JARVIS_VERSION) { $url = "https://github.com/$repo/releases/download/$($env:JARVIS_VERSION)/$name" }
    else { $url = "https://github.com/$repo/releases/latest/download/$name" }
  }

  if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Host 'error: Jarvis needs 64-bit Windows.' -ForegroundColor Red
    exit 1
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('jarvis-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $setup = Join-Path $tmp $name

  try {
    Write-Host 'Jarvis installer'
    Write-Host "-> downloading $url"
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($curl) {
      & $curl.Source -fsSL $url -o $setup
      if ($LASTEXITCODE -ne 0) { throw "download failed: $url (curl exit code $LASTEXITCODE)" }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
    }
    if (-not (Test-Path $setup) -or (Get-Item $setup).Length -lt 1MB) { throw "download failed: $url" }

    # Close a running copy so the installer can replace it (roamies: its program name before the rename).
    $dirs = @((Join-Path $env:LOCALAPPDATA 'Jarvis'), (Join-Path $env:ProgramFiles 'Jarvis'))
    Get-Process -Name jarvis, roamies -ErrorAction SilentlyContinue | Where-Object {
      $p = $_.Path; $p -and ($dirs | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host '-> installing'
    $proc = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "the installer failed (exit code $($proc.ExitCode))" }

    $app = $dirs | ForEach-Object { Join-Path $_ 'jarvis.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $app) { throw 'the installer finished, but Jarvis is not where it should be' }
    # The programs an install from before the rename left beside it (roamies.exe and its helpers): unused now.
    Get-ChildItem (Split-Path $app) -Filter 'roamies*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

    if ($env:JARVIS_NO_OPEN -ne '1') { Start-Process -FilePath $app }
    Write-Host "Jarvis is installed in $(Split-Path $app)" -ForegroundColor Green
  } catch {
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

