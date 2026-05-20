$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization="Bearer $t"; Accept="application/json"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }

$job = (Invoke-RestMethod -Uri "$o/api/data/v9.2/acp_migrationjobs?`$orderby=createdon desc&`$top=1" -Headers $h).value[0]
$jobId = $job.acp_migrationjobid
"Job: $jobId  state=$($job.statecode) status=$($job.statuscode)  created=$($job.createdon)  modified=$($job.modifiedon)"

$anns = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations?`$filter=_objectid_value eq $jobId&`$select=annotationid,filename,filesize,createdon&`$orderby=createdon" -Headers $h).value

function GetAnn($name) {
  $a = $anns | Where-Object { $_.filename -eq $name } | Select-Object -First 1
  if (-not $a) { return $null }
  $b = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations($($a.annotationid))?`$select=documentbody" -Headers $h).documentbody
  [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b))
}

"=== REPORT ==="
GetAnn "migration-report.json"

"`n=== LOG TAIL (60) ==="
(GetAnn "migration-log.ndjson") -split "`n" | Select-Object -Last 60

"`n=== ARTIFACTS ==="
$anns | Select-Object filename, filesize | Format-Table -AutoSize | Out-String

"`n=== IDMAP SIZES ==="
foreach ($f in ($anns | Where-Object { $_.filename -like "idmap-*.json" })) {
  $c = GetAnn $f.filename
  try { $j = $c | ConvertFrom-Json; "$($f.filename): $((@($j.PSObject.Properties)).Count) entries" } catch { "$($f.filename): parse err" }
}

"`n=== REJECTED COUNTS ==="
foreach ($f in ($anns | Where-Object { $_.filename -like "*-rejected.ndjson" })) {
  $c = GetAnn $f.filename
  $lines = ($c -split "`n" | Where-Object { $_.Trim() }).Count
  "$($f.filename): $lines rejected"
}
