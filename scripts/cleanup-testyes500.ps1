$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization="Bearer $t"; Accept="application/json"; "Content-Type"="application/json"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }

function DelAll($entitySet) {
    try {
        $rows = (Invoke-RestMethod -Uri "$o/api/data/v9.2/$entitySet" -Headers $h).value
        $idProp = ($rows | Select-Object -First 1).PSObject.Properties.Name | Where-Object { $_ -match '^(acp_\w+id|productid)$' -and $_ -notmatch '_value$' } | Select-Object -First 1
        if (-not $idProp) { Write-Host "$entitySet — no id prop, skipping"; return }
        $n = 0
        foreach ($r in $rows) {
            $id = $r.$idProp
            try { Invoke-WebRequest -Uri "$o/api/data/v9.2/$entitySet($id)" -Method Delete -Headers $h -UseBasicParsing | Out-Null; $n++ } catch { Write-Host "  del $id failed: $($_.Exception.Message)" }
        }
        Write-Host "$entitySet — deleted $n row(s)"
    } catch { Write-Host "$entitySet — list failed: $($_.Exception.Message)" }
}

# 1. Wipe rows (orders first — they FK to product; products FK to categories+suppliers)
Write-Host "--- Deleting rows ---"
DelAll "acp_orderses"
DelAll "acp_categorieses"
DelAll "acp_supplierses"
# product: only delete rows that came from the import (have an acp_productid number)
try {
    $prods = (Invoke-RestMethod -Uri "$o/api/data/v9.2/products?`$filter=acp_productid ne null&`$select=productid,acp_productid" -Headers $h).value
    foreach ($p in $prods) {
        try { Invoke-WebRequest -Uri "$o/api/data/v9.2/products($($p.productid))" -Method Delete -Headers $h -UseBasicParsing | Out-Null } catch { Write-Host "  product $($p.productid) del fail: $($_.Exception.Message)" }
    }
    Write-Host "product — deleted $($prods.Count) imported row(s)"
} catch { Write-Host "product wipe failed: $($_.Exception.Message)" }

# 2. Find the testyes500 solution + its publisher
$sol = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=uniquename eq 'testyes500'&`$select=solutionid,_publisherid_value" -Headers $h).value | Select-Object -First 1
if (-not $sol) { Write-Host "Solution testyes500 not found"; }
else {
    $solId = $sol.solutionid; $pubId = $sol._publisherid_value
    Write-Host "Found solution testyes500 id=$solId publisher=$pubId"

    # 3. Remove acp_* attrs we added to product
    Write-Host "--- Stripping acp_* attrs from product ---"
    foreach ($a in @("acp_productid","acp_unitsinstock","acp_discontinued")) {
        try {
            $url = "$o/api/data/v9.2/EntityDefinitions(LogicalName='product')/Attributes(LogicalName='$a')"
            Invoke-WebRequest -Uri $url -Method Delete -Headers $h -UseBasicParsing | Out-Null
            Write-Host "  deleted product.$a"
        } catch { Write-Host "  product.$a del fail: $($_.Exception.Message)" }
    }

    # 4. Delete the 3 custom entities (retry a few times for dependency order)
    $pending = [System.Collections.ArrayList]@("acp_orders","acp_categories","acp_suppliers")
    for ($r=1; $r -le 3 -and $pending.Count -gt 0; $r++) {
        $still = [System.Collections.ArrayList]@()
        foreach ($e in $pending) {
            try { Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$e')" -Method Delete -Headers $h -UseBasicParsing | Out-Null; Write-Host "deleted entity $e (round $r)" }
            catch { Write-Host "round ${r}: $e $($_.Exception.Message)"; [void]$still.Add($e) }
        }
        $pending = $still
    }

    # 5. Delete the solution
    try { Invoke-WebRequest -Uri "$o/api/data/v9.2/solutions($solId)" -Method Delete -Headers $h -UseBasicParsing | Out-Null; Write-Host "deleted solution testyes500" } catch { Write-Host "sol del fail: $($_.Exception.Message)" }

    # 6. Delete the publisher if orphaned
    $pubSols = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=_publisherid_value eq $pubId&`$select=uniquename" -Headers $h).value
    Write-Host "Publisher still owns $($pubSols.Count) solution(s)"
    if ($pubSols.Count -eq 0) {
        try { Invoke-WebRequest -Uri "$o/api/data/v9.2/publishers($pubId)" -Method Delete -Headers $h -UseBasicParsing | Out-Null; Write-Host "deleted publisher" } catch { Write-Host "pub del fail: $($_.Exception.Message)" }
    }
}

# 7. Publish
try { Invoke-WebRequest -Uri "$o/api/data/v9.2/PublishAllXml" -Method Post -Headers $h -UseBasicParsing | Out-Null; Write-Host "PublishAllXml OK" } catch { Write-Host "PublishAllXml fail: $($_.Exception.Message)" }

# 8. Optional: delete the prior migration job + annotations to keep the list clean
try {
    $jobs = (Invoke-RestMethod -Uri "$o/api/data/v9.2/acp_migrationjobs?`$select=acp_migrationjobid&`$orderby=createdon desc" -Headers $h).value
    Write-Host "Deleting $($jobs.Count) prior migration job(s)..."
    foreach ($j in $jobs) {
        try { Invoke-WebRequest -Uri "$o/api/data/v9.2/acp_migrationjobs($($j.acp_migrationjobid))" -Method Delete -Headers $h -UseBasicParsing | Out-Null } catch { Write-Host "  job del fail: $($_.Exception.Message)" }
    }
} catch { Write-Host "job list fail: $($_.Exception.Message)" }
