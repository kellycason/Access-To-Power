$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization="Bearer $t"; Accept="application/json"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }
$jobId = "6ba35703-f352-f111-bec5-001dd806a793"
function GetAnn($name) {
  $a = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations?`$filter=_objectid_value eq $jobId and filename eq '$name'&`$select=annotationid" -Headers $h).value[0]
  $b = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations($($a.annotationid))?`$select=documentbody" -Headers $h).documentbody
  [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b))
}
"=== REPORT ===" | Out-File scripts\_inspect.txt -Encoding utf8
GetAnn "migration-report.json" | Out-File scripts\_inspect.txt -Append -Encoding utf8
"`n=== LOG TAIL ===" | Out-File scripts\_inspect.txt -Append -Encoding utf8
(GetAnn "migration-log.ndjson") -split "`n" | Select-Object -Last 80 | Out-File scripts\_inspect.txt -Append -Encoding utf8
foreach ($f in @("Categories-rejected.ndjson","Suppliers-rejected.ndjson","Products-rejected.ndjson","Orders-rejected.ndjson")) {
  "`n=== $f (first 2 lines) ===" | Out-File scripts\_inspect.txt -Append -Encoding utf8
  (GetAnn $f) -split "`n" | Select-Object -First 2 | Out-File scripts\_inspect.txt -Append -Encoding utf8
}
Write-Host "WROTE scripts\_inspect.txt"
