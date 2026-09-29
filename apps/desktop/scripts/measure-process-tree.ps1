param(
  [Parameter(Mandatory = $true)][int[]]$RootProcessIds,
  [ValidateRange(10, 3600)][int]$DurationSeconds = 120,
  [ValidateRange(1, 30)][int]$IntervalSeconds = 2,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$samples = [System.Collections.Generic.List[object]]::new()
$previousCpu = @{}
$logicalProcessors = [Environment]::ProcessorCount
$started = Get-Date
$previousAt = $started

while (((Get-Date) - $started).TotalSeconds -lt $DurationSeconds) {
  # Query only process IDs and parents; never read command lines or window titles.
  $processRows = Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId FROM Win32_Process'
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($rootId in $RootProcessIds) { [void]$ids.Add($rootId) }
  do {
    $added = $false
    foreach ($row in $processRows) {
      if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true }
    }
  } while ($added)

  $now = Get-Date
  $elapsed = ($now - $previousAt).TotalSeconds
  $cpuDelta = 0.0
  $workingBytes = 0L
  $privateBytes = 0L
  $liveCount = 0
  $nextCpu = @{}
  foreach ($processId in $ids) {
    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      # Start time distinguishes a recycled PID from its earlier process.
      $key = "$processId/$($process.StartTime.ToUniversalTime().Ticks)"
      $cpu = [double]$process.CPU
      if ($previousCpu.ContainsKey($key)) { $cpuDelta += [Math]::Max(0, $cpu - $previousCpu[$key]) }
      $nextCpu[$key] = $cpu
      $workingBytes += $process.WorkingSet64
      $privateBytes += $process.PrivateMemorySize64
      $liveCount += 1
    } catch {
      # A child may exit between enumeration and sampling.
      continue
    }
  }
  $samples.Add([pscustomobject]@{
    elapsedSeconds = [Math]::Round(($now - $started).TotalSeconds, 2)
    processCount = $liveCount
    workingSetMiB = [Math]::Round($workingBytes / 1MB, 2)
    privateBytesMiB = [Math]::Round($privateBytes / 1MB, 2)
    cpuPercentOfMachine = $(if ($samples.Count -eq 0 -or $elapsed -le 0) { $null } else { [Math]::Round(100 * $cpuDelta / $elapsed / $logicalProcessors, 2) })
  })
  $previousCpu = $nextCpu
  $previousAt = $now
  Start-Sleep -Seconds $IntervalSeconds
}

[pscustomobject]@{
  schemaVersion = 1
  sampledAtUtc = $started.ToUniversalTime().ToString('o')
  logicalProcessors = $logicalProcessors
  intervalSeconds = $IntervalSeconds
  caveat = 'CPU is sampled and excludes work by processes that start and exit between samples. Working set totals may count shared pages more than once.'
  samples = $samples
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
