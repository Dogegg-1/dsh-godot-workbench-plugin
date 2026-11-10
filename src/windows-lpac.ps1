param(
[Parameter(Mandatory=$true)][string]$Executable,
[Parameter(Mandatory=$true)][string]$SandboxRoot,
[Parameter(Mandatory=$true)][string]$ArgumentsFile,
[ValidateRange(1,3600000)][int]$TimeoutMs=60000,
[switch]$WindowCompatible
)
$ErrorActionPreference='Stop'
# Only the fresh staging trees receive ACL changes, never the source project.
function AbsolutePath([string]$value) {
    if(-not [IO.Path]::IsPathRooted($value)){
        throw 'Absolute paths required'
    }
    return [IO.Path]::GetFullPath($value).TrimEnd('\')
}
function Within([string]$parent,[string]$child) {
    return $child.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase)
}
function NoReparse([string]$value) {
    $item=Get-Item -LiteralPath $value -Force
    while($null -ne $item){
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
            throw 'Reparse points are not allowed in sandbox paths'
        }
        $item=$item.Parent
        # FileInfo has Directory rather than Parent; validate ancestors separately below.
    }
}
$root=AbsolutePath $SandboxRoot;
$exe=AbsolutePath $Executable;
$argsFile=AbsolutePath $ArgumentsFile
$engine=Join-Path $root 'engine';
$game=Join-Path $root 'game'
if(-not (Within $engine $exe) -or -not (Within $root $argsFile) -or (Within $game $argsFile)){
    throw 'Invalid sandbox layout'
}
if([IO.Path]::GetFileName($exe) -match '(?i)console'){
    throw 'Use the copied real Godot executable, not its console wrapper'
}
foreach($dir in @($root,$engine,$game)){
    if(-not (Test-Path -LiteralPath $dir -PathType Container)){
        throw 'Missing sandbox directory'
    }
    ;
    NoReparse $dir
}
foreach($file in @($exe,$argsFile)){
    if(-not (Test-Path -LiteralPath $file -PathType Leaf)){
        throw 'Missing sandbox input'
    }
    ;
    NoReparse $file;
    NoReparse ([IO.Path]::GetDirectoryName($file))
}
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-lpac.cs')))
# Inspect one directory at a time. Never descend through a reparse point.
$pending = New-Object 'System.Collections.Generic.Stack[string]'
$pending.Push($engine)
$pending.Push($game)
$entryCount = 0
$maxEntries = 25000
while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    NoReparse $directory
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
        $entryCount++
        if ($entryCount -gt $maxEntries) {
            throw 'Sandbox exceeds 25000 entries'
        }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Sandbox tree contains a reparse point'
        }
        if ($item.PSIsContainer) {
            $pending.Push($item.FullName)
        }
        else {
            [GodotWindowsLpac]::ValidateFile($item.FullName)
        }
    }
}
$icacls = Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe'
if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
    throw 'System icacls is unavailable'
}
$json=[IO.File]::ReadAllText($argsFile)
if(-not $json.TrimStart().StartsWith('[')){
    throw 'Arguments must be a JSON string array'
}
$parsedArguments = ConvertFrom-Json -InputObject $json
# PS5.1 emits the entire JSON array as one pipeline item. Enumerate the assigned
# array once, retaining nested arrays as invalid elements instead of coercing them.
$arguments = @($parsedArguments)
foreach($arg in $arguments){
    if($arg -isnot [string] -or $arg.IndexOf([char]0) -ge 0){
        throw 'Invalid Godot argument'
    }
}
$log=Join-Path $game '.workbench-lpac.log'
$delimiter=[Array]::IndexOf($arguments,'--');
if($delimiter -lt 0){
    $delimiter=$arguments.Length
}
$logIndex=[Array]::IndexOf($arguments,'--log-file')
if($logIndex -ge 0 -and $logIndex -lt $delimiter){
    if($logIndex+1 -ge $delimiter){
        throw 'Missing log path'
    }
    $log=AbsolutePath $arguments[$logIndex+1]
    if(-not (Within $game $log)){
        throw 'Log must stay inside sandbox game directory'
    }
    NoReparse ([IO.Path]::GetDirectoryName($log))
    if(Test-Path -LiteralPath $log){
        NoReparse $log
    }
}
else{
    $arguments=@('--log-file',$log)+$arguments
}
$profile='dsh.godot.run.'+[Guid]::NewGuid().ToString('N');
$created=$false
$stateFile=Join-Path $root ($profile+'.json')
$state=@{
    profile=$profile;
    created=$false;
    cleaned=$false;
    sandbox='windows-lpac';
    logFile=$log
}
$state.lpacRequested = -not [bool]$WindowCompatible
$state.activeProcessLimit = 1
if ($WindowCompatible) { $state.sandbox = 'windows-appcontainer' }
[IO.File]::WriteAllText($stateFile,($state|ConvertTo-Json -Compress))
try {
    $sid=[GodotWindowsLpac]::Create($profile);
    $created=$true;
    $state.created=$true
    [IO.File]::WriteAllText($stateFile,($state|ConvertTo-Json -Compress))
    & $icacls $engine /grant ('*'+$sid+':(OI)(CI)RX') /T /Q | Out-Null
    if($LASTEXITCODE -ne 0){
        throw 'Engine ACL grant failed'
    }
    & $icacls $game /grant ('*'+$sid+':(OI)(CI)M') /T /Q | Out-Null
    if($LASTEXITCODE -ne 0){
        throw 'Game ACL grant failed'
    }
    & $icacls $game /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null
    if($LASTEXITCODE -ne 0){
        throw 'Game integrity label failed'
    }
    $result=[GodotWindowsLpac]::Run($profile,$exe,$game,[string[]]$arguments,[uint32]$TimeoutMs,[bool]$WindowCompatible)
    $state.exitCode=$result.ExitCode;
    $state.timedOut=$result.TimedOut;
    $state.processId=$result.ProcessId
    $state.isAppContainer=$result.IsAppContainer;
    $state.capabilityCount=0
}
finally {
    if($created){
        [GodotWindowsLpac]::Delete($profile);
        $state.cleaned=$true
    }
    [IO.File]::WriteAllText($stateFile,($state|ConvertTo-Json -Compress))
}
# Child failures are data; launcher/ACL/token failures throw and exit nonzero.
$state|ConvertTo-Json -Compress
