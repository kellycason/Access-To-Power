<#
.SYNOPSIS
    Reverts a single Access-To-Power migration: deletes the custom tables,
    custom columns on existing tables, the solution, and the publisher.

.PARAMETER JobName
    Migration job name (matches acp_migrationjob.acp_name). Required.

.PARAMETER DeletePublisher
    Also delete the publisher record. Default: true if no other solutions reference it.

.EXAMPLE
    pwsh ./scripts/cleanup-migration.ps1 -JobName "mew again"
#>
param(
    [Parameter(Mandatory=$true)] [string]$JobName,
    [string]$EnvUrl = "https://yourorg.crm.dynamics.com",
    [switch]$KeepJob,
    [switch]$WhatIf,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Get-Token { az account get-access-token --resource $EnvUrl --query accessToken -o tsv }
$token = Get-Token
$h = @{ Authorization="Bearer $token"; Accept="application/json"
        "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }
$hWrite = $h.Clone(); $hWrite['Content-Type'] = 'application/json'; $hWrite['If-Match'] = '*'

function Invoke-Dv($method, $path, $body) {
    $url = "$EnvUrl/api/data/v9.2/$path"
    if ($WhatIf -and $method -ne 'GET') { Write-Host "  [WHATIF] $method $path"; return $null }
    $params = @{ Uri=$url; Method=$method; Headers=$hWrite }
    if ($body) { $params['Body'] = $body }
    try { Invoke-RestMethod @params } catch {
        $msg = $_.Exception.Message
        if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
        throw "$method $path failed: $msg"
    }
}

Write-Host "=== Cleanup '$JobName' on $EnvUrl ==="

# 1. Find job
$jobName = $JobName.Replace("'", "''")
$jobUrl = "acp_migrationjobs?`$filter=acp_name eq '$jobName'&`$select=acp_migrationjobid,acp_targetpublisherprefix,acp_targetsolutionname"
$jobResp = Invoke-Dv 'GET' $jobUrl
$job = $jobResp.value | Select-Object -First 1
if (-not $job) { Write-Host "  Job not found (already cleaned up?). Continuing with prefix/solution lookup is not possible." -ForegroundColor Yellow; return }
$jobId = $job.acp_migrationjobid
$prefix = $job.acp_targetpublisherprefix
$solution = $job.acp_targetsolutionname
Write-Host "  job=$jobId  prefix=$prefix  solution=$solution"

# 1b. Read the migration plan annotation to know which entities are new vs existing.
$planAnn = (Invoke-Dv 'GET' "annotations?`$filter=_objectid_value eq $jobId and filename eq 'migration-plan.json'&`$select=annotationid").value | Select-Object -First 1
$newEntityLogicalNames = @()        # entities the migration created; delete whole
$existingEntityModifications = @{}  # logical -> list of attrLogical we added
if ($planAnn) {
    $planBody = (Invoke-Dv 'GET' "annotations($($planAnn.annotationid))?`$select=documentbody").documentbody
    if ($planBody) {
        $planJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($planBody))
        $plan = $planJson | ConvertFrom-Json
        foreach ($t in $plan.tableMappings) {
            if ($t.action -ne 'Migrate') { continue }
            $entityLogical = $t.dataverseSchemaName.ToLowerInvariant()
            if ($t.targetMode -eq 'existing') {
                $addedAttrs = @()
                foreach ($f in $t.fields) {
                    if ($f.action -ne 'Map') { continue }
                    if ($f.targetMode -eq 'new') {
                        $addedAttrs += $f.dataverseSchemaName.ToLowerInvariant()
                    }
                }
                $existingEntityModifications[$entityLogical] = $addedAttrs
            } else {
                $newEntityLogicalNames += $entityLogical
            }
        }
    }
}


# 2. Resolve solution + its components BEFORE we delete anything
$solResp = Invoke-Dv 'GET' "solutions?`$filter=uniquename eq '$solution'&`$select=solutionid,ismanaged"
$sol = $solResp.value | Select-Object -First 1
if ($sol -and $sol.ismanaged) {
    Write-Host "  Solution '$solution' is MANAGED — can't safely delete components individually. Aborting." -ForegroundColor Red
    return
}

# Track entities owned by the solution that we will delete entirely.
$ownedEntityLogicalNames = @()
$customAttrsOnExisting = @()  # @{ entity=...; attr=...; metadataId=... }

if ($sol) {
    $solId = $sol.solutionid
    Write-Host "  solutionid=$solId"
    $compResp = Invoke-Dv 'GET' "solutioncomponents?`$filter=_solutionid_value eq $solId&`$select=componenttype,objectid"
    $comps = $compResp.value

    # Component type 1 = Entity, 2 = Attribute, 10 = Relationship
    $entityComps = $comps | Where-Object { $_.componenttype -eq 1 }
    $attrComps   = $comps | Where-Object { $_.componenttype -eq 2 }

    # Resolve entities — use the migration plan (above) as the source of truth for
    # new vs existing. Anything not in the plan is left alone.
    foreach ($ec in $entityComps) {
        try {
            $e = Invoke-Dv 'GET' "EntityDefinitions($($ec.objectid))?`$select=LogicalName,IsCustomEntity"
            $logical = $e.LogicalName.ToLowerInvariant()
            if ($newEntityLogicalNames -contains $logical) {
                $ownedEntityLogicalNames += $logical
            } elseif ($existingEntityModifications.ContainsKey($logical)) {
                $addedAttrs = $existingEntityModifications[$logical]
                $eFull = Invoke-Dv 'GET' "EntityDefinitions($($ec.objectid))?`$select=LogicalName&`$expand=Attributes(`$select=LogicalName,MetadataId,IsCustomAttribute)"
                foreach ($a in $eFull.Attributes) {
                    $aLogical = $a.LogicalName.ToLowerInvariant()
                    if ($a.IsCustomAttribute -and ($addedAttrs -contains $aLogical)) {
                        $customAttrsOnExisting += [pscustomobject]@{
                            Entity = $logical
                            Attr = $aLogical
                            MetadataId = $a.MetadataId
                        }
                    }
                }
            } else {
                Write-Host "  ? entity $logical is in solution but not in migration plan; skipping." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "    (could not resolve entity $($ec.objectid): $($_.Exception.Message))" -ForegroundColor Yellow
        }
    }
}

Write-Host "`n=== Plan ==="
Write-Host "  Delete entire entities: $($ownedEntityLogicalNames -join ', ')"
Write-Host "  Delete attributes on existing tables:"
$customAttrsOnExisting | ForEach-Object { Write-Host "    $($_.Entity).$($_.Attr)" }
Write-Host "  Delete solution: $solution"
Write-Host "  Delete publisher: $prefix"
Write-Host "  Delete migration job: $(if ($KeepJob) {'NO (--KeepJob)'} else {"YES ($jobId)"})"

if (-not $WhatIf -and -not $Force) {
    $ans = Read-Host "`nProceed with deletion? (y/N)"
    if ($ans -ne 'y' -and $ans -ne 'Y') { Write-Host "Aborted."; return }
}

# 3. Delete custom attributes on existing tables FIRST (entities go after)
foreach ($a in $customAttrsOnExisting) {
    Write-Host "  Deleting $($a.Entity).$($a.Attr)…"
    try {
        Invoke-Dv 'DELETE' "EntityDefinitions(LogicalName='$($a.Entity)')/Attributes(LogicalName='$($a.Attr)')" | Out-Null
    } catch {
        Write-Host "    failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 4. Delete entire owned entities (this also removes their relationships)
foreach ($logical in $ownedEntityLogicalNames) {
    Write-Host "  Deleting entity $logical…"
    try {
        Invoke-Dv 'DELETE' "EntityDefinitions(LogicalName='$logical')" | Out-Null
    } catch {
        Write-Host "    failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 5. Delete solution
if ($sol) {
    Write-Host "  Deleting solution $solution…"
    try {
        Invoke-Dv 'DELETE' "solutions($($sol.solutionid))" | Out-Null
    } catch {
        Write-Host "    failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 6. Delete publisher only if no other solutions still reference it
$pubResp = Invoke-Dv 'GET' "publishers?`$filter=customizationprefix eq '$prefix'&`$select=publisherid"
$pub = $pubResp.value | Select-Object -First 1
if ($pub) {
    $otherSolutions = (Invoke-Dv 'GET' "solutions?`$filter=_publisherid_value eq $($pub.publisherid)&`$select=solutionid,uniquename&`$top=5").value `
        | Where-Object { $_.uniquename -ne 'Default' -and $_.uniquename -ne 'Active' }
    if ($otherSolutions -and $otherSolutions.Count -gt 0) {
        Write-Host "  Publisher $prefix still has solutions: $($otherSolutions.uniquename -join ', '). Keeping." -ForegroundColor Yellow
    } else {
        Write-Host "  Deleting publisher $prefix…"
        try {
            Invoke-Dv 'DELETE' "publishers($($pub.publisherid))" | Out-Null
        } catch {
            Write-Host "    failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# 7. Delete migration job (cascades annotations)
if (-not $KeepJob) {
    Write-Host "  Deleting migration job $jobId…"
    try {
        Invoke-Dv 'DELETE' "acp_migrationjobs($jobId)" | Out-Null
    } catch {
        Write-Host "    failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host "`n=== Publishing customizations ==="
try {
    Invoke-Dv 'POST' 'PublishAllXml' '{}' | Out-Null
} catch {
    Write-Host "  PublishAllXml failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`nDone." -ForegroundColor Green
