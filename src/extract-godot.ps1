param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$Stem)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$allowed=@("$Stem.exe", "${Stem}_console.exe")
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
  if($zip.Entries.Count -ne 2){throw 'Unexpected archive layout'}
  $total=0
  foreach($entry in $zip.Entries){
    if($entry.FullName -cnotin $allowed -or $entry.Length -lt 1){throw 'Unexpected archive entry'}
    $total+=$entry.Length
    if($total -gt 600000000){throw 'Expanded package too large'}
  }
  foreach($entry in $zip.Entries){
    $target=Join-Path $Destination $entry.FullName
    $output=[IO.File]::Open($target,[IO.FileMode]::CreateNew)
    $inputStream=$entry.Open()
    try {$inputStream.CopyTo($output)} finally {$inputStream.Dispose();$output.Dispose()}
  }
} finally {$zip.Dispose()}
