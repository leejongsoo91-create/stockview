# StockView wmux layout preset applier.
# Each preset lives in its own wmux workspace named "SV-<preset>".
# First call builds it; later calls only switch to it (running panes are never killed)
# unless -Rebuild or -Close is given.
#
# Usage (from project root, inside or outside wmux):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/wmux-layout/apply-layout.ps1 -List
#   ... -Preset basic            build or switch
#   ... -Preset basic -Rebuild   close that workspace (kills its panes) and build again
#   ... -Preset basic -Close     close that workspace
#   ... -Preset parallel -Worktrees chart-fix,news-filter
#   ... -Preset basic -DryRun    print the plan only
param(
    [string]$Preset,
    [string[]]$Worktrees = @(),
    [switch]$List,
    [switch]$Rebuild,
    [switch]$Close,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Project = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$LayoutFile = Join-Path $Project '.claude\wmux-layouts.json'
$W = Join-Path $env:LOCALAPPDATA 'wmux\bin\wmux.cmd'

if (-not (Test-Path $W)) { throw "wmux CLI not found: $W (is wmux installed?)" }

# wmux.cmd writes harmless noise to stderr (cmd.exe "UNC paths are not supported" when the cwd is
# \\wsl.localhost\..., and a crashpad "CreateFile" log line). With 'Stop' + 2>&1, PS 5.1 turned that
# into a terminating error, so: run from a local folder, keep stderr apart, and judge failure only by
# the exit code or an "Error:" line.
function Wm {
    $eap = $ErrorActionPreference
    Push-Location -LiteralPath $env:TEMP
    try {
        $ErrorActionPreference = 'Continue'
        $all = & $W @args 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap; Pop-Location }
    $out = ($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | Out-String)
    $err = (@($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n")
    if ($code -ne 0 -or $out -match '(?m)^\s*Error:' -or $err -match '(?m)^\s*Error:') {
        throw "wmux $($args -join ' ') failed (exit $code): $out $err"
    }
    return $out
}
# PS 5.1 returns a JSON array as ONE object; ForEach-Object unrolls it into real elements.
# (Without this, filtering by name matched the whole list and close-workspace got every id.)
function WmJson { return ((Wm @args) | ConvertFrom-Json) | ForEach-Object { $_ } }

function Test-Port([int]$p) {
    $c = New-Object Net.Sockets.TcpClient
    try { $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null); return ($iar.AsyncWaitHandle.WaitOne(500) -and $c.Connected) }
    catch { return $false } finally { $c.Close() }
}
function Q([string]$s) { return "'" + $s.Replace("'", "''") + "'" }   # PowerShell single-quote literal

$cfg = Get-Content -Raw -Encoding UTF8 $LayoutFile | ConvertFrom-Json
$names = @($cfg.presets.PSObject.Properties.Name)
$workspaces = @(WmJson list-workspaces --json)

if ($List -or -not $Preset) {
    Write-Host "Presets ($LayoutFile):"
    foreach ($n in $names) {
        $p = $cfg.presets.$n
        $ws = $workspaces | Where-Object { $_.name -eq "SV-$n" }
        $state = if ($ws) { 'open' } else { '-' }
        Write-Host ("  {0,-10} {1,-6} [{2}] {3}" -f $n, $p.title, $state, $p.description)
    }
    return
}

# allow the Korean title as well as the key
$key = $names | Where-Object { $_ -eq $Preset -or $cfg.presets.$_.title -eq $Preset } | Select-Object -First 1
if (-not $key) { throw "Unknown preset '$Preset'. Available: $($names -join ', ')" }
$p = $cfg.presets.$key
$wsName = "SV-$key"
$existing = $workspaces | Where-Object { $_.name -eq $wsName } | Select-Object -First 1
if ($existing -and ($existing.id -isnot [string] -or $existing.id -notmatch '^ws-')) { throw "Bad workspace lookup for $wsName" }

# ── switch / close an existing workspace (before building the spec, so -Close needs no -Worktrees) ──
if ($existing -and -not $DryRun) {
    if ($Close -or $Rebuild) {
        Wm close-workspace $existing.id --force | Out-Null
        Write-Host "Closed workspace $wsName ($($existing.id))"
        if ($Close) { return }
    } else {
        Wm focus-workspace $existing.id | Out-Null
        Write-Host "Switched to existing workspace $wsName (nothing restarted). Use -Rebuild to recreate."
        return
    }
} elseif ($Close) { Write-Host "Workspace $wsName is not open."; return }

# ── build the column/pane spec ──
$columns = @()
if ($p.perWorktree) {
    if ($Worktrees.Count -eq 0) { throw "Preset '$key' needs -Worktrees name1,name2" }
    $Worktrees = @($Worktrees | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
    for ($i = 0; $i -lt $Worktrees.Count; $i++) {
        $port = [int]$p.portBase + $i
        $col = @()
        foreach ($t in $p.perWorktree) {
            $json = ($t | ConvertTo-Json -Compress).Replace('{wt}', $Worktrees[$i]).Replace('{port}', "$port")
            $col += ($json | ConvertFrom-Json)
        }
        $columns += , $col
    }
} else {
    foreach ($c in $p.columns) { $columns += , @($c) }
}

if ($DryRun) {
    Write-Host "Preset $key ($($p.title)) -> workspace $wsName  existing=$([bool]$existing)"
    for ($c = 0; $c -lt $columns.Count; $c++) {
        foreach ($s in $columns[$c]) { Write-Host ("  col{0}: {1,-14} cwd={2} cmd={3} port={4} browser={5}" -f $c, $s.name, $s.cwd, $s.cmd, $s.port, $s.browser) }
    }
    return
}

# ── create workspace and split ──
$created = Wm new-workspace --name $wsName
if ($created -notmatch '\((ws-[^)]+)\)') { throw "Could not parse workspace id: $created" }
$wsId = $Matches[1]
Wm focus-workspace $wsId | Out-Null

function Get-ActivePane {
    $panes = (WmJson list-panes --json).panes
    $a = $panes | Where-Object { $_.active } | Select-Object -First 1
    return [pscustomobject]@{ id = $a.id; pty = $a.surfacePtyIds[0] }
}
function Split-From($pane, [string]$dir) {
    Wm focus-pane $pane.id | Out-Null
    Wm split --direction $dir | Out-Null
    $new = Get-ActivePane
    if ($new.id -eq $pane.id) { throw "split did not create a new pane" }
    return $new
}

$grid = @()
$grid += , @(Get-ActivePane)
for ($c = 1; $c -lt $columns.Count; $c++) { $grid += , @(Split-From $grid[$c - 1][0] 'right') }
for ($c = 0; $c -lt $columns.Count; $c++) {
    for ($r = 1; $r -lt $columns[$c].Count; $r++) { $grid[$c] += Split-From $grid[$c][$r - 1] 'down' }
}

# ── start each pane ──
$report = @()
for ($c = 0; $c -lt $columns.Count; $c++) {
    for ($r = 0; $r -lt $columns[$c].Count; $r++) {
        $s = $columns[$c][$r]; $pane = $grid[$c][$r]
        $rel = if ($s.cwd) { $s.cwd } else { '.' }
        $cwd = [IO.Path]::GetFullPath((Join-Path $Project $rel))
        $note = ''
        $missing = -not (Test-Path $cwd)
        if ($missing) { $note = "folder missing, nothing started: $cwd"; $cwd = $Project }

        $line = "Set-Location -LiteralPath $(Q $cwd); `$Host.UI.RawUI.WindowTitle = $(Q $s.name)"
        $port = if ($s.port) { [int]$s.port } else { 0 }
        if ($port) { $line += "; `$env:PORT = '$port'" }

        if ($missing) {
            # never run claude/server in the main project folder by mistake
            $line += "; Write-Host 'folder missing - not started: $(([IO.Path]::GetFullPath((Join-Path $Project $rel))).Replace("'", "''"))'"
        } elseif ($s.browser) {
            $u = [uri]$s.browser
            $wait = if ($u.Host -in @('127.0.0.1', 'localhost')) { $u.Port } else { 0 }
            $line += "; `$null = Start-Job -ArgumentList $(Q $s.browser),$wait -ScriptBlock { param(`$u,`$p); " +
                     "if (`$p) { for (`$i = 0; `$i -lt 90; `$i++) { try { (New-Object Net.Sockets.TcpClient('127.0.0.1', `$p)).Close(); break } catch { Start-Sleep 1 } } }; " +
                     "Set-Location -LiteralPath `$env:TEMP; & (Join-Path `$env:LOCALAPPDATA 'wmux\bin\wmux.cmd') open `$u 2>`$null }"
        }
        if ($s.cmd -and -not $missing) {
            if ($port -and (Test-Port $port)) {
                $line += "; Write-Host 'port $port already in use - not starting: $($s.cmd.Replace("'", "''"))'"
                $note = ($note + " port $port busy, cmd skipped").Trim()
            } else { $line += "; $($s.cmd)" }
        }
        Wm send $line --submit --to $pane.pty | Out-Null
        $report += [pscustomobject]@{ col = $c; name = $s.name; pty = $pane.pty; pane = $pane.id; note = $note }
    }
}

Wm focus-pane $grid[0][0].id | Out-Null
Write-Host "Built workspace $wsName ($wsId) for preset $key ($($p.title))"
$report | Format-Table -AutoSize | Out-String | Write-Host
