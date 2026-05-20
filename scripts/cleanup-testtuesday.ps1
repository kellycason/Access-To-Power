$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization="Bearer $t"; Accept="application/json"; "Content-Type"="application/json"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }

function DelAll($entitySet, $idProp) {
    try {
        $rows = (Invoke-RestMethod -Uri "$o/api/data/v9.2/$entitySet" -Headers $h).value
        $n = 0
        foreach ($r in $rows) {
            $id = $r.$idProp
            try { Invoke-WebRequest -Uri "$o/api/data/v9.2/$entitySet($id)" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; $n++ } catch { Write-Host "  del fail: $($_.Exception.Message)" }
        }
        Write-Host "$entitySet -- deleted $n"
    } catch { Write-Host "$entitySet -- list fail: $($_.Exception.Message)" }
}

Write-Host "--- Deleting rows ---"
DelAll "acp_orderses" "acp_ordersid"
DelAll "acp_categorieses" "acp_categoriesid"
DelAll "acp_supplierses" "acp_suppliersid"

# Wipe all products (only 20, all from Northwind)
$prods = (Invoke-RestMethod -Uri "$o/api/data/v9.2/products?`$select=productid" -Headers $h).value
$pn = 0
foreach ($p in $prods) {
    try { Invoke-WebRequest -Uri "$o/api/data/v9.2/products($($p.productid))" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; $pn++ } catch { Write-Host "  prod del fail: $($_.Exception.Message)" }
}
Write-Host "products -- deleted $pn"

# Find TestTuesday
$sol = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=uniquename eq 'TestTuesday'&`$select=solutionid,_publisherid_value" -Headers $h).value | Select-Object -First 1
if (-not $sol) { Write-Host "TestTuesday not found"; return }
$solId = $sol.solutionid; $pubId = $sol._publisherid_value
Write-Host "TestTuesday id=$solId publisher=$pubId"

# Strip product.acp_* attrs (must drop lookups before deleting parent entities)
Write-Host "--- Stripping product.acp_* attrs ---"
$pa = (Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='product')/Attributes?`$select=LogicalName" -Headers $h).value | Where-Object { $_.LogicalName -like 'acp_*' } | ForEach-Object { $_.LogicalName }
foreach ($a in $pa) {
    try {
        Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='product')/Attributes(LogicalName='$a')" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null
        Write-Host "  deleted product.$a"
    } catch { Write-Host "  product.$a fail: $($_.Exception.Message)" }
}

# Delete the 3 custom entities (try ordered: orders -> categories/suppliers)
$pending = [System.Collections.ArrayList]@("acp_orders","acp_categories","acp_suppliers")
for ($r=1; $r -le 3 -and $pending.Count -gt 0; $r++) {
    $still = [System.Collections.ArrayList]@()
    foreach ($e in $pending) {
        try { Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$e')" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; Write-Host "deleted entity $e (round $r)" }
        catch { Write-Host "round ${r}: $e $($_.Exception.Message)"; [void]$still.Add($e) }
    }
    $pending = $still
}

# Delete solution
try { Invoke-WebRequest -Uri "$o/api/data/v9.2/solutions($solId)" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; Write-Host "deleted solution TestTuesday" } catch { Write-Host "sol del fail: $($_.Exception.Message)" }

# Delete publisher if orphan
$pubSols = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=_publisherid_value eq $pubId&`$select=uniquename" -Headers $h).value
Write-Host "Publisher still owns $($pubSols.Count) solution(s)"
if ($pubSols.Count -eq 0) {
    try { Invoke-WebRequest -Uri "$o/api/data/v9.2/publishers($pubId)" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; Write-Host "deleted publisher" } catch { Write-Host "pub del fail: $($_.Exception.Message)" }
}

try { Invoke-WebRequest -Uri "$o/api/data/v9.2/PublishAllXml" -Method Post -Headers $h -UseBasicParsing -TimeoutSec 180 | Out-Null; Write-Host "PublishAllXml OK" } catch { Write-Host "publish fail: $($_.Exception.Message)" }
