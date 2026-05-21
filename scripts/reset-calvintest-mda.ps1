# Reset the CalvinTest MDA so it can be regenerated from history.
# - Deletes the appmodule + sitemap referenced by mda-result.json
# - Deletes the mda-result.json and mda-log.ndjson annotations on the job
# - Leaves entities, data, and the rest of the job untouched
$ErrorActionPreference = 'Stop'
$o = "https://yourorg.crm.dynamics.com"
$token = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$hd = @{ Authorization = "Bearer $token"; Accept = "application/json"; "Content-Type" = "application/json"; "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0" }
$jobId = "f3ae8444-4455-f111-bec5-001dd81163a1"

Write-Host "Looking up MDA annotations on job $jobId..."
$annsUri = "$o/api/data/v9.2/annotations?`$filter=_objectid_value eq $jobId and (filename eq 'mda-result.json' or filename eq 'mda-log.ndjson')&`$select=annotationid,filename"
$anns = (Invoke-RestMethod -Uri $annsUri -Headers $hd).value
$mdaR = $anns | Where-Object filename -eq 'mda-result.json' | Select-Object -First 1
if (-not $mdaR) { Write-Host "No mda-result.json found - nothing to reset."; return }

$bodyB64 = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations($($mdaR.annotationid))?`$select=documentbody" -Headers $hd).documentbody
$res = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($bodyB64)) | ConvertFrom-Json
Write-Host "MDA result:"; $res | ConvertTo-Json -Depth 5 | Write-Host

# Delete appmodule
if ($res.appModuleId) {
    try {
        Invoke-WebRequest -Uri "$o/api/data/v9.2/appmodules($($res.appModuleId))" -Method Delete -Headers $hd -UseBasicParsing | Out-Null
        Write-Host "Deleted appmodule $($res.appModuleId)"
    } catch { Write-Host "AppModule delete failed: $($_.Exception.Message)" }
}

# Delete sitemap
if ($res.sitemapId) {
    try {
        Invoke-WebRequest -Uri "$o/api/data/v9.2/sitemaps($($res.sitemapId))" -Method Delete -Headers $hd -UseBasicParsing | Out-Null
        Write-Host "Deleted sitemap $($res.sitemapId)"
    } catch { Write-Host "Sitemap delete failed: $($_.Exception.Message)" }
}

# Delete the MDA annotations so the SPA shows the Generate button again
foreach ($a in $anns) {
    try {
        Invoke-WebRequest -Uri "$o/api/data/v9.2/annotations($($a.annotationid))" -Method Delete -Headers $hd -UseBasicParsing | Out-Null
        Write-Host "Deleted annotation $($a.filename)"
    } catch { Write-Host "Annotation $($a.filename) delete failed: $($_.Exception.Message)" }
}

try {
    Invoke-WebRequest -Uri "$o/api/data/v9.2/PublishAllXml" -Method Post -Headers $hd -Body '{}' -UseBasicParsing | Out-Null
    Write-Host "PublishAllXml OK"
} catch { Write-Host "PublishAllXml failed: $($_.Exception.Message)" }

Write-Host "`nDone. Reload the wizard and the Generate model-driven app action should be available again."
