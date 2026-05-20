$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization = "Bearer $t"; Accept = "application/json"; "Content-Type" = "application/json"; "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0" }

foreach ($e in @("acp_products", "acp_suppliers")) {
  try {
    Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$e')" -Method Delete -Headers $h -UseBasicParsing | Out-Null
    Write-Host "DELETED $e"
  } catch { Write-Host "FAIL ${e}: $($_.Exception.Message)" }
}

$sol = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=uniquename eq 'Testing15'&`$select=solutionid,_publisherid_value" -Headers $h).value
if ($sol) {
  $solId = $sol[0].solutionid
  $pubId = $sol[0]._publisherid_value
  try {
    Invoke-WebRequest -Uri "$o/api/data/v9.2/solutions($solId)" -Method Delete -Headers $h -UseBasicParsing | Out-Null
    Write-Host "DELETED solution Testing15"
  } catch { Write-Host "FAIL solution: $($_.Exception.Message)" }

  $refs = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=_publisherid_value eq $pubId&`$select=uniquename" -Headers $h).value
  if ($refs.Count -eq 0) {
    try {
      Invoke-WebRequest -Uri "$o/api/data/v9.2/publishers($pubId)" -Method Delete -Headers $h -UseBasicParsing | Out-Null
      Write-Host "DELETED publisher $pubId"
    } catch { Write-Host "FAIL publisher: $($_.Exception.Message)" }
  } else { Write-Host "Publisher still referenced: $(($refs | ForEach-Object { $_.uniquename }) -join ', ')" }
} else { Write-Host "Solution Testing15 already gone" }

try {
  Invoke-WebRequest -Uri "$o/api/data/v9.2/PublishAllXml" -Method Post -Headers $h -UseBasicParsing | Out-Null
  Write-Host "PublishAllXml OK"
} catch { Write-Host "PublishAllXml fail: $($_.Exception.Message)" }
