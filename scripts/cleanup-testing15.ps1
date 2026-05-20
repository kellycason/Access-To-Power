$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization = "Bearer $t"; Accept = "application/json"; "Content-Type" = "application/json"; "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0" }

Write-Host "=== 1. Marking stuck jobs as Failed ==="
$filter = "statecode eq 0 and statuscode eq 1"
$jobs = (Invoke-RestMethod -Uri "$o/api/data/v9.2/acp_migrationjobs?`$filter=$filter&`$select=acp_migrationjobid,acp_name" -Headers $h).value
foreach ($j in $jobs) {
  try {
    $body = @{ statecode = 1; statuscode = 11 } | ConvertTo-Json
    Invoke-WebRequest -Uri "$o/api/data/v9.2/acp_migrationjobs($($j.acp_migrationjobid))" -Method Patch -Headers $h -Body $body -UseBasicParsing | Out-Null
    Write-Host "  Failed: $($j.acp_name)"
  } catch { Write-Host "  Could not patch $($j.acp_migrationjobid): $($_.Exception.Message)" }
}

Write-Host "=== 2. Removing acp_categoryid from OOB product ==="
try {
  Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='product')/Attributes(LogicalName='acp_categoryid')" -Method Delete -Headers $h -UseBasicParsing | Out-Null
  Write-Host "  DELETED product.acp_categoryid"
} catch { Write-Host "  Skip: $($_.Exception.Message)" }

Write-Host "=== 3. Deleting custom entities ==="
$ents = @("acp_orders", "acp_products", "acp_suppliers")
for ($r = 1; $r -le 3 -and $ents.Count -gt 0; $r++) {
  $still = @()
  foreach ($e in $ents) {
    try {
      Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$e')" -Method Delete -Headers $h -UseBasicParsing | Out-Null
      Write-Host "  DELETED $e (round $r)"
    } catch {
      Write-Host "  Round ${r}: ${e} -> $($_.Exception.Message)"
      $still += $e
    }
  }
  $ents = $still
}
if ($ents.Count -gt 0) { Write-Host "  STILL PENDING: $($ents -join ', ')" }

Write-Host "=== 4. Deleting solution Testing15 ==="
$sol = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=uniquename eq 'Testing15'&`$select=solutionid,_publisherid_value" -Headers $h).value
if ($sol) {
  $solId = $sol[0].solutionid
  $pubId = $sol[0]._publisherid_value
  try {
    Invoke-WebRequest -Uri "$o/api/data/v9.2/solutions($solId)" -Method Delete -Headers $h -UseBasicParsing | Out-Null
    Write-Host "  DELETED solution Testing15"
  } catch { Write-Host "  $($_.Exception.Message)" }

  Write-Host "=== 5. Deleting publisher (id=$pubId) if orphaned ==="
  $refs = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=_publisherid_value eq $pubId&`$select=uniquename" -Headers $h).value
  if ($refs.Count -eq 0) {
    try {
      Invoke-WebRequest -Uri "$o/api/data/v9.2/publishers($pubId)" -Method Delete -Headers $h -UseBasicParsing | Out-Null
      Write-Host "  DELETED publisher"
    } catch { Write-Host "  $($_.Exception.Message)" }
  } else { Write-Host "  Publisher still referenced by: $(($refs | ForEach-Object { $_.uniquename }) -join ', ')" }
} else { Write-Host "  Solution Testing15 not found" }

Write-Host "=== 6. PublishAllXml ==="
try {
  Invoke-WebRequest -Uri "$o/api/data/v9.2/PublishAllXml" -Method Post -Headers $h -UseBasicParsing | Out-Null
  Write-Host "  OK"
} catch { Write-Host "  $($_.Exception.Message)" }
