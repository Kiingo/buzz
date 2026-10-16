#!/usr/bin/env bash
set -euo pipefail

platform=${1:?usage: desktop-native-toolchain-id.sh <macos|linux|windows>}
case "$platform" in
  macos)
    {
      sw_vers
      xcodebuild -version
      xcrun --sdk macosx --show-sdk-path
      xcrun --sdk macosx --show-sdk-version
      xcrun clang --version
    } ;;
  linux)
    {
      cat /etc/os-release
      dpkg-query -W -f='${Package}=${Version}\n' \
        build-essential libasound2-dev libayatana-appindicator3-dev \
        libgtk-3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev \
        libxdo-dev patchelf pkg-config
      gcc -dumpfullversion -dumpversion
      gcc -dumpmachine
      ld --version
    } ;;
  windows)
    {
      cmd.exe //c ver
      # Discover registered C++ installations rather than a year-specific path.
      # Include preview toolsets too; hashing every available candidate is
      # conservative when Cargo or a native build selects a different instance.
      powershell.exe -NoProfile -NonInteractive -Command '
        $ErrorActionPreference = "Stop"
        $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
        $raw = & $vswhere -products "*" -prerelease -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8
        if ($LASTEXITCODE -ne 0) { throw "Visual Studio discovery failed" }
        $instances = @(($raw -join "`n") | ConvertFrom-Json)
        if ($instances.Count -eq 0) { throw "No registered Visual C++ toolchain" }
        foreach ($instance in ($instances | Sort-Object installationPath)) {
          if ([string]::IsNullOrWhiteSpace($instance.installationPath) -or [string]::IsNullOrWhiteSpace($instance.installationVersion)) {
            throw "Incomplete Visual Studio identity"
          }
          "visualStudio=$($instance.installationVersion)"
          "installation=$($instance.installationPath)"
          $toolsetPath = Join-Path $instance.installationPath "VC\Tools\MSVC"
          $toolsets = @(Get-ChildItem -LiteralPath $toolsetPath -Directory)
          if ($toolsets.Count -eq 0) { throw "No installed MSVC toolset" }
          $toolsets | Sort-Object Name | ForEach-Object { "msvc=$($_.Name)" }
          $defaultPath = Join-Path $instance.installationPath "VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt"
          $defaultVersion = (Get-Content -LiteralPath $defaultPath -Raw).Trim()
          if ([string]::IsNullOrWhiteSpace($defaultVersion)) { throw "Missing default MSVC toolset" }
          "msvcDefault=$defaultVersion"
        }
        $sdkPath = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Include"
        $sdkVersions = @(Get-ChildItem -LiteralPath $sdkPath -Directory)
        if ($sdkVersions.Count -eq 0) { throw "No installed Windows SDK" }
        $sdkVersions | Sort-Object Name | ForEach-Object { "windowsSdk=$($_.Name)" }
      '
      cmake --version
    } ;;
  *)
    echo "unsupported native toolchain platform: $platform" >&2
    exit 1 ;;
esac | tr -d '\r' | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
