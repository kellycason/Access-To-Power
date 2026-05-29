# Cleanup for the 6 binary-migration test runs done before the MDA form fix.
# Removes: model-driven apps, custom entities, custom attributes on OOTB tables,
# solutions, publishers, migration jobs (and cascaded annotations).
# One PublishAllXml at the end.
#
# This is additive to scripts/cleanup-migration.ps1 — the existing script doesn't
# delete model-driven apps (componenttype=80), which leaves orphaned sitemap
# shells pointing at deleted entities.
param(
    [string]$EnvUrl = "https://yourorg.crm.dynamics.com",
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$envUrl = $EnvUrl
$tok = az account get-access-token --resource $envUrl --query accessToken -o tsv
$h = @{ Authorization = "Bearer $tok"; Accept = "application/json"
        "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0" }
$hWrite = $h.Clone(); $hWrite['Content-Type'] = 'application/json'; $hWrite['If-Match'] = '*'

function Dv([string]$method, [string]$path, [object]$body = $null) {
    $url = "$envUrl/api/data/v9.2/$path"
    if ($WhatIf -and $method -ne 'GET') { Write-Host "    [WHATIF] $method $path" -ForegroundColor DarkGray; return $null }
    $p = @{ Uri = $url; Method = $method; Headers = $hWrite }
    if ($body) { $p['Body'] = ($body | ConvertTo-Json -Depth 10) }
    try { Invoke-RestMethod @p } catch {
        $msg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        Write-Host "    ! $method $path : $msg" -ForegroundColor Yellow
        return $null
    }
}

# Hard-coded from the inventory just run. Jobs[0..6] include the duplicate FileTest job.
$jobs = @(
    @{ name='FileTestD';   jobId='feea7759-de5a-f111-bec5-001dd8097d07'; prefix='filetesd'; solName='FileTestD';   solId='5ef8819b-de5a-f111-bec5-001dd8097b43' },
    @{ name='filetest3';   jobId='858552f7-da5a-f111-bec5-001dd809796c'; prefix='filetesc'; solName='filetest3';   solId='b621ee39-db5a-f111-bec5-001dd8097d07' },
    @{ name='FileTest2';   jobId='c4fdd50b-d95a-f111-bec5-001dd809796c'; prefix='filetesb'; solName='FileTest2';   solId='56097078-d95a-f111-bec5-001dd8097c02' },
    @{ name='FileTest';    jobId='f74ced42-d55a-f111-bec5-001dd8097b43'; prefix='filetest'; solName='FileTest';    solId='9eecb25c-d65a-f111-bec5-001dd8097d07' },
    @{ name='FileTest(dup)'; jobId='65bb69f1-d55a-f111-bec5-001dd8097b43'; prefix='filetest'; solName='FileTest';  solId='9eecb25c-d65a-f111-bec5-001dd8097d07' },
    @{ name='ChoiceField'; jobId='95974024-d05a-f111-bec5-001dd8097d15'; prefix='choicefi'; solName='ChoiceField'; solId='97af9589-d05a-f111-bec5-001dd8097c02' },
    @{ name='TestDoug2';   jobId='70a7a87a-cc5a-f111-bec5-001dd8097c02'; prefix='testdoug'; solName='TestDoug2';   solId='19517296-cc5a-f111-bec5-001dd8097b43' }
)

# Track solutions/publishers we've already wiped so dup jobs (FileTest x2) don't
# double-delete and so we only try the publisher once per prefix.
$deletedSolutions = @{}
$deletedPublishers = @{}

foreach ($j in $jobs) {
    Write-Host ""
    Write-Host "===== $($j.name) =====" -ForegroundColor Cyan

    # 1. Read migration plan from job annotation so we know which entities are NEW
    #    (delete entire) vs which are EXISTING (delete only the added attrs).
    $newEnts = @()
    $existingAttrs = @{}  # entityLogical -> @(attrLogical, ...)
    $planAnn = (Dv 'GET' "annotations?`$filter=_objectid_value eq $($j.jobId) and filename eq 'migration-plan.json'&`$select=annotationid")
    $annId = if ($planAnn) { ($planAnn.value | Select-Object -First 1).annotationid } else { $null }
    if ($annId) {
        $body = (Dv 'GET' "annotations($annId)?`$select=documentbody").documentbody
        if ($body) {
            $plan = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($body)) | ConvertFrom-Json
            foreach ($t in $plan.tableMappings) {
                if ($t.action -ne 'Migrate') { continue }
                $eLog = $t.dataverseSchemaName.ToLowerInvariant()
                if ($t.targetMode -eq 'existing') {
                    $existingAttrs[$eLog] = @($t.fields | Where-Object { $_.action -eq 'Map' -and $_.targetMode -eq 'new' } | ForEach-Object { $_.dataverseSchemaName.ToLowerInvariant() })
                } else {
                    $newEnts += $eLog
                }
            }
        }
    }
    Write-Host "  plan: new entities=$($newEnts -join ',')  existing+attrs=$(($existingAttrs.Keys | ForEach-Object { "$_($($existingAttrs[$_] -join ','))" }) -join ' ')" -ForegroundColor DarkGray

    # 2. Solution components — find appmodules + cross-check entity list.
    $apps = @()
    if (-not $deletedSolutions.ContainsKey($j.solId)) {
        $comps = (Dv 'GET' "solutioncomponents?`$filter=_solutionid_value eq $($j.solId)&`$select=componenttype,objectid").value
        $apps = @($comps | Where-Object { $_.componenttype -eq 80 } | ForEach-Object { $_.objectid })

        # If plan annotation was missing, fall back to solution entity components.
        if ($newEnts.Count -eq 0 -and $existingAttrs.Count -eq 0) {
            foreach ($e in ($comps | Where-Object { $_.componenttype -eq 1 })) {
                $md = Dv 'GET' "EntityDefinitions($($e.objectid))?`$select=LogicalName,IsCustomEntity"
                if ($md -and $md.IsCustomEntity) { $newEnts += $md.LogicalName.ToLowerInvariant() }
            }
            Write-Host "  fallback: entities from solution components: $($newEnts -join ',')" -ForegroundColor DarkGray
        }
    }

    # 3. Delete model-driven app(s) BEFORE the entities — otherwise the sitemap
    #    references break and the appmodule lingers as an orphan in the env.
    foreach ($appId in $apps) {
        Write-Host "  deleting appmodule $appId" -ForegroundColor Magenta
        Dv 'DELETE' "appmodules($appId)" | Out-Null
    }

    # 4. Delete custom attributes added to OOTB tables.
    foreach ($entityLogical in $existingAttrs.Keys) {
        foreach ($attrLogical in $existingAttrs[$entityLogical]) {
            Write-Host "  deleting attr $entityLogical.$attrLogical"
            Dv 'DELETE' "EntityDefinitions(LogicalName='$entityLogical')/Attributes(LogicalName='$attrLogical')" | Out-Null
        }
    }

    # 5. Delete new entities (cascades relationships, forms, views).
    foreach ($entityLogical in $newEnts) {
        Write-Host "  deleting entity $entityLogical"
        Dv 'DELETE' "EntityDefinitions(LogicalName='$entityLogical')" | Out-Null
    }

    # 6. Delete the solution shell (once per solId).
    if (-not $deletedSolutions.ContainsKey($j.solId)) {
        Write-Host "  deleting solution $($j.solName)"
        Dv 'DELETE' "solutions($($j.solId))" | Out-Null
        $deletedSolutions[$j.solId] = $true
    } else {
        Write-Host "  solution $($j.solName) already deleted (dup job)" -ForegroundColor DarkGray
    }

    # 7. Delete publisher only once per prefix + only if nothing else references it.
    if (-not $deletedPublishers.ContainsKey($j.prefix)) {
        $pub = (Dv 'GET' "publishers?`$filter=customizationprefix eq '$($j.prefix)'&`$select=publisherid").value | Select-Object -First 1
        if ($pub) {
            $others = (Dv 'GET' "solutions?`$filter=_publisherid_value eq $($pub.publisherid)&`$select=uniquename&`$top=5").value `
                | Where-Object { $_.uniquename -ne 'Default' -and $_.uniquename -ne 'Active' }
            if ($others -and $others.Count -gt 0) {
                Write-Host "  publisher '$($j.prefix)' still owns: $($others.uniquename -join ', ') — keeping" -ForegroundColor Yellow
            } else {
                Write-Host "  deleting publisher $($j.prefix)"
                Dv 'DELETE' "publishers($($pub.publisherid))" | Out-Null
                $deletedPublishers[$j.prefix] = $true
            }
        }
    }

    # 8. Delete migration job (annotations cascade).
    Write-Host "  deleting job $($j.jobId)"
    Dv 'DELETE' "acp_migrationjobs($($j.jobId))" | Out-Null
}

Write-Host ""
Write-Host "===== PublishAllXml =====" -ForegroundColor Cyan
Dv 'POST' 'PublishAllXml' @{} | Out-Null

Write-Host ""
Write-Host "Done." -ForegroundColor Green
