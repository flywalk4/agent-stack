# agent-stack bootstrap (Windows, PowerShell 5.1+): ensures node + uv + git, then runs the interactive installer.
$ErrorActionPreference = 'Stop'

$Repo = if ($env:AGENT_STACK_REPO) { $env:AGENT_STACK_REPO } else { 'https://github.com/flywalk4/agent-stack.git' }
$Dir  = if ($env:AGENT_STACK_DIR)  { $env:AGENT_STACK_DIR }  else { Join-Path $HOME '.agent-stack\app' }

function Need($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not (Need node)) {
  Write-Host '-> installing Node.js LTS'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
}
if (-not (Need uv)) {
  Write-Host '-> installing uv'
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  Refresh-Path
}
if (-not (Need git)) {
  Write-Host '-> installing git'
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
}

$Src = $PSScriptRoot
if ($Src -and (Test-Path (Join-Path $Src 'bin\agent-stack.js'))) {
  $Dir = $Src
} elseif (Test-Path (Join-Path $Dir '.git')) {
  git -C $Dir pull --ff-only -q
} else {
  git clone -q --depth 1 $Repo $Dir
}

Set-Location $Dir
npm install --omit=dev --silent
npm link --silent *> $null
node bin/agent-stack.js install @args
