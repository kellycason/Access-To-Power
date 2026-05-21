$orgUrl = "https://yourorg.crm.dynamics.com"
$token = (az account get-access-token --resource $orgUrl | ConvertFrom-Json).accessToken
$hd = @{ Authorization="Bearer $token"; Accept="application/json"; "Content-Type"="application/json"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }

function Get-ErrMsg($err) {
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) { return $err.ErrorDetails.Message }
    return $err.Exception.Message
}

$targets = @("acp_category", "acp_supplier")

foreach ($t in $targets) {
    Write-Host ""
    Write-Host "=== $t ==="

    # ManyToOne (lookups on $t pointing elsewhere)
    foreach ($relType in @("ManyToOneRelationships","OneToManyRelationships","ManyToManyRelationships")) {
        try {
            $url = "$orgUrl/api/data/v9.2/EntityDefinitions(LogicalName='$t')/$relType"
            $rels = (Invoke-RestMethod -Uri $url -Headers $hd).value
            foreach ($r in $rels) {
                if ($r.IsCustomRelationship -ne $true) { continue }
                $sn = $r.SchemaName
                Write-Host "  [$relType] deleting $sn"
                try {
                    Invoke-WebRequest -Uri "$orgUrl/api/data/v9.2/RelationshipDefinitions(SchemaName='$sn')" -Method Delete -Headers $hd -UseBasicParsing | Out-Null
                    Write-Host "    deleted $sn"
                } catch {
                    Write-Host ("    FAILED $sn : " + (Get-ErrMsg $_))
                }
            }
        } catch {
            Write-Host ("  $relType lookup failed: " + (Get-ErrMsg $_))
        }
    }
}

# publish then retry entity deletes
try { Invoke-WebRequest -Uri "$orgUrl/api/data/v9.2/PublishAllXml" -Method Post -Headers $hd -Body '{}' -UseBasicParsing | Out-Null; Write-Host "Published." } catch { Write-Host "Publish failed" }
Start-Sleep -Seconds 5

foreach ($t in $targets) {
    Write-Host ""
    Write-Host "Final delete of $t"
    try {
        Invoke-WebRequest -Uri "$orgUrl/api/data/v9.2/EntityDefinitions(LogicalName='$t')" -Method Delete -Headers $hd -UseBasicParsing | Out-Null
        Write-Host "  DELETED $t"
    } catch {
        Write-Host ("  FAILED $t : " + (Get-ErrMsg $_))
    }
}

try { Invoke-WebRequest -Uri "$orgUrl/api/data/v9.2/PublishAllXml" -Method Post -Headers $hd -Body '{}' -UseBasicParsing | Out-Null; Write-Host "Published." } catch {}

Write-Host ""
Write-Host "=== verify ==="
foreach ($t in $targets + @("acp_order")) {
    try {
        Invoke-RestMethod -Uri "$orgUrl/api/data/v9.2/EntityDefinitions(LogicalName='$t')?`$select=LogicalName" -Headers $hd -ErrorAction Stop | Out-Null
        Write-Host "  STILL: $t"
    } catch {
        Write-Host "  GONE: $t"
    }
}

# Delete leftover TestNWLite job record if still around
$jobs = (Invoke-RestMethod -Uri "$orgUrl/api/data/v9.2/acp_migrationjobs?`$filter=acp_name eq 'TestNWLite'&`$select=acp_migrationjobid" -Headers $hd).value
foreach ($j in $jobs) {
    try {
        Invoke-WebRequest -Uri "$orgUrl/api/data/v9.2/acp_migrationjobs($($j.acp_migrationjobid))" -Method Delete -Headers $hd -UseBasicParsing | Out-Null
        Write-Host "  Deleted job $($j.acp_migrationjobid)"
    } catch {
        Write-Host ("  Job delete failed: " + (Get-ErrMsg $_))
    }
}
$jobsAfter = (Invoke-RestMethod -Uri "$orgUrl/api/data/v9.2/acp_migrationjobs?`$filter=acp_name eq 'TestNWLite'&`$select=acp_name" -Headers $hd).value.Count
Write-Host "Jobs TestNWLite remaining: $jobsAfter"
