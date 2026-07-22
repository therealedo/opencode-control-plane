param(
  [Parameter(Mandatory = $false)][int]$OwnerPid = 0,
  [Parameter(Mandatory = $false)][string]$Specification = "",
  [switch]$Bootstrap,
  [string]$SpecFile = "",
  [string]$GoFile = ""
)

$ErrorActionPreference = "Stop"

function Quote-WindowsArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $slashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($slashes * 2) + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Start-RedirectedProcess([string]$FileName, [string[]]$Arguments) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $FileName
  $start.Arguments = (($Arguments | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join ' ')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  # Inherit stdin through both guard hops. CopyToAsync does not close its
  # destination at EOF, which can leave commands that read stdin hung forever.
  $start.RedirectStandardInput = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "Could not start guarded process" }
  return $process
}

function Copy-Streams($Process) {
  $output = $Process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $errorOutput = $Process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  return @($output, $errorOutput)
}

if ($Bootstrap) {
  while (-not (Test-Path -LiteralPath $GoFile)) { Start-Sleep -Milliseconds 25 }
  $encoded = [System.IO.File]::ReadAllText($SpecFile)
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $spec = $json | ConvertFrom-Json
  $target = Start-RedirectedProcess ([string]$spec.command) @($spec.args | ForEach-Object { [string]$_ })
  $copies = Copy-Streams $target
  $target.WaitForExit()
  $code = $target.ExitCode
  [Threading.Tasks.Task]::WaitAll(@($copies[0], $copies[1]), 2000) | Out-Null
  try { $target.StandardOutput.Close() } catch {}
  try { $target.StandardError.Close() } catch {}
  exit $code
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AutopilotJob {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMITS {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMITS {
    public BASIC_LIMITS BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS info, uint length);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@

$job = [AutopilotJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed" }
$limits = New-Object AutopilotJob+EXTENDED_LIMITS
$limits.BasicLimitInformation.LimitFlags = 0x00002000
$size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
if (-not [AutopilotJob]::SetInformationJobObject($job, 9, [ref]$limits, $size)) {
  [void][AutopilotJob]::CloseHandle($job)
  throw "SetInformationJobObject failed"
}

$owner = $null
try {
  $owner = [Diagnostics.Process]::GetProcessById($OwnerPid)
  # Materialize a handle once so later PID reuse cannot impersonate the owner.
  [void]$owner.Handle
} catch {
  [void][AutopilotJob]::CloseHandle($job)
  $job = [IntPtr]::Zero
  exit 124
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("autopilot-job-" + [Guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$specPath = Join-Path $temporary "spec.txt"
$goPath = Join-Path $temporary "go"
[IO.File]::WriteAllText($specPath, $Specification, (New-Object Text.UTF8Encoding($false)))
$self = $MyInvocation.MyCommand.Path
$powerShell = (Get-Process -Id $PID).Path
$child = $null
try {
  $child = Start-RedirectedProcess $powerShell @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $self, "-Bootstrap", "-SpecFile", $specPath, "-GoFile", $goPath
  )
  if (-not [AutopilotJob]::AssignProcessToJobObject($job, $child.Handle)) {
    try { $child.Kill() } catch {}
    throw "AssignProcessToJobObject failed; guarded execution is unavailable"
  }
  $copies = Copy-Streams $child
  [IO.File]::WriteAllText($goPath, "go")
  while (-not $child.WaitForExit(250)) {
    if ($owner.HasExited) {
      [void][AutopilotJob]::TerminateJobObject($job, 124)
      exit 124
    }
  }
  $code = $child.ExitCode
  [void][AutopilotJob]::TerminateJobObject($job, 0)
  [Threading.Tasks.Task]::WaitAll(@($copies[0], $copies[1]), 2000) | Out-Null
  exit $code
} finally {
  if ($null -ne $owner) { try { $owner.Dispose() } catch {} }
  if ($job -ne [IntPtr]::Zero) { [void][AutopilotJob]::CloseHandle($job) }
  try { Remove-Item -LiteralPath $temporary -Recurse -Force } catch {}
}
