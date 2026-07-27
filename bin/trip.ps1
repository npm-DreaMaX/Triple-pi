$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
& "$RepoRoot\pi-runtime\pi-test.ps1" @args
