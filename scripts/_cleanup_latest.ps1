# Cleans up the most recent migration job's footprint.
#
# Reads `migration-plan.json` from the latest acp_migrationjob and uses the
# TableMappings to do TARGETED cleanup:
#
#   targetMode == "new"      -> wipe rows + delete the entity
#   targetMode == "existing" -> delete ONLY the rows we created (idmap GUIDs);
#                               drop any new acp_* attrs we added; remove the
#                               entity from the migration's solution. The
#                               entity itself and its pre-existing rows stay.
#
# Always: deletes the migration's solution + orphan publisher, deletes ALL
# acp_migrationjobs rows (cascades annotations), runs PublishAllXml.
#
# Won't touch any acp_migration* / acp_fieldmappingdecision app entities.

$ErrorActionPreference = 'Stop'
$o = "https://yourorg.crm.dynamics.com"
$tok = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization = "Bearer $tok"; Accept = "application/json"; "Content-Type" = "application/json"; "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0" }

function Get-AnnotationText($jobId, $fileName) {
    $ann = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations?`$filter=_objectid_value eq $jobId and filename eq '$fileName'&`$select=annotationid" -Headers $h).value
    if (-not $ann) { return $null }
    $b = (Invoke-RestMethod -Uri "$o/api/data/v9.2/annotations($($ann[0].annotationid))?`$select=documentbody" -Headers $h).documentbody
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))
}

function Get-EntitySetName($logical) {
    try {
        return (Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$logical')?`$select=EntitySetName" -Headers $h).EntitySetName
    } catch { return $null }
}

# --- 1. Find latest job + plan ----------------------------------------
$job = (Invoke-RestMethod -Uri "$o/api/data/v9.2/acp_migrationjobs?`$orderby=createdon desc&`$top=1" -Headers $h).value | Select-Object -First 1
if (-not $job) { "No migration jobs to clean up."; exit 0 }
$jobId = $job.acp_migrationjobid
"Latest job: $($job.acp_name) id=$jobId prefix=$($job.acp_targetpublisherprefix) sol=$($job.acp_targetsolutionname)"

$planText = Get-AnnotationText $jobId 'migration-plan.json'
if (-not $planText) { Write-Warning "No migration-plan.json on job $jobId; aborting (acp_* sweep is unsafe without the plan)."; exit 1 }
$plan = $planText | ConvertFrom-Json

$migrate = $plan.tableMappings | Where-Object { $_.action -eq 'Migrate' }
$newTables = @($migrate | Where-Object { $_.targetMode -eq 'new' })
$existingTables = @($migrate | Where-Object { $_.targetMode -eq 'existing' })
"Plan: $($newTables.Count) new table(s), $($existingTables.Count) existing table(s) reused"

# --- 2. EXISTING tables: delete only the rows we created --------------
foreach ($t in $existingTables) {
    $logical = $t.dataverseSchemaName.ToLowerInvariant()
    $setName = Get-EntitySetName $logical
    if (-not $setName) { "  $logical : entity not found, skipping"; continue }

    $idmapText = Get-AnnotationText $jobId "idmap-$logical.json"
    if (-not $idmapText) { "  $logical : no idmap on job, leaving rows alone"; continue }
    $idmap = $idmapText | ConvertFrom-Json
    $guids = @($idmap.PSObject.Properties.Value)
    $delN = 0; $missN = 0
    foreach ($g in $guids) {
        try { Invoke-WebRequest -Uri "$o/api/data/v9.2/$setName($g)" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; $delN++ }
        catch { if ($_.Exception.Message -match '404') { $missN++ } else { Write-Warning "  $logical $g del fail: $($_.Exception.Message)" } }
    }
    "  $logical : deleted $delN of our rows ($missN already gone). Pre-existing rows left intact."
}

# --- 3. EXISTING tables: drop NEW acp_* attrs added by this migration  -
foreach ($t in $existingTables) {
    $logical = $t.dataverseSchemaName.ToLowerInvariant()
    $newAttrs = @($t.fields | Where-Object { $_.action -eq 'Map' -and $_.targetMode -eq 'new' -and $_.dataverseSchemaName })
    foreach ($f in $newAttrs) {
        $attr = $f.dataverseSchemaName.ToLowerInvariant()
        try {
            Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$logical')/Attributes(LogicalName='$attr')" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null
            "  removed attr $logical.$attr"
        } catch {
            if ($_.Exception.Message -match '404') { "  attr $logical.$attr already gone" }
            else { Write-Warning "  attr $logical.$attr fail: $($_.Exception.Message)" }
        }
    }
}

# --- 4. NEW tables: wipe rows then delete the entity ------------------
foreach ($t in $newTables) {
    $logical = $t.dataverseSchemaName.ToLowerInvariant()
    $setName = Get-EntitySetName $logical
    if (-not $setName) { "  $logical : already gone"; continue }
    try {
        $rows = (Invoke-RestMethod -Uri "$o/api/data/v9.2/${setName}?`$select=${logical}id" -Headers $h).value
        $idCol = "${logical}id"
        $n = 0
        foreach ($r in $rows) { try { Invoke-WebRequest -Uri "$o/api/data/v9.2/$setName($($r.$idCol))" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; $n++ } catch {} }
        "  $logical : wiped $n rows"
    } catch { Write-Warning "  $logical wipe fail: $($_.Exception.Message)" }
}

for ($r = 1; $r -le 3; $r++) {
    $stillThere = $false
    foreach ($t in $newTables) {
        $logical = $t.dataverseSchemaName.ToLowerInvariant()
        try {
            Invoke-WebRequest -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$logical')" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 90 | Out-Null
            "  entity $logical deleted (round $r)"
        } catch {
            if ($_.Exception.Message -match '404') { } # already gone
            else { $stillThere = $true; if ($r -eq 3) { Write-Warning "  $logical r${r}: $($_.Exception.Message)" } }
        }
    }
    if (-not $stillThere) { break }
}

# --- 5. Delete the migration's solution + orphan publisher ------------
$solName = $job.acp_targetsolutionname
if ($solName) {
    $sols = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=uniquename eq '$solName'&`$select=solutionid,_publisherid_value" -Headers $h).value
    foreach ($s in $sols) {
        try { Invoke-WebRequest -Uri "$o/api/data/v9.2/solutions($($s.solutionid))" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; "  solution $solName deleted" }
        catch { Write-Warning "  sol del fail: $($_.Exception.Message)" }
        $other = (Invoke-RestMethod -Uri "$o/api/data/v9.2/solutions?`$filter=_publisherid_value eq $($s._publisherid_value)" -Headers $h).value
        if ($other.Count -eq 0) {
            try { Invoke-WebRequest -Uri "$o/api/data/v9.2/publishers($($s._publisherid_value))" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; "  publisher deleted (orphan)" }
            catch { Write-Warning "  pub del fail: $($_.Exception.Message)" }
        } else {
            "  publisher kept (still owns $($other.Count) solution(s))"
        }
    }
}

# --- 6. Delete ALL migration jobs (cascades annotations) --------------
$jobs = (Invoke-RestMethod -Uri "$o/api/data/v9.2/acp_migrationjobs?`$select=acp_migrationjobid,acp_name" -Headers $h).value
foreach ($j in $jobs) {
    try { Invoke-WebRequest -Uri "$o/api/data/v9.2/acp_migrationjobs($($j.acp_migrationjobid))" -Method Delete -Headers $h -UseBasicParsing -TimeoutSec 60 | Out-Null; "  job $($j.acp_name) deleted" }
    catch { Write-Warning "  job $($j.acp_name) del fail: $($_.Exception.Message)" }
}

# --- 7. Publish -------------------------------------------------------
try { Invoke-WebRequest -Uri "$o/api/data/v9.2/PublishAllXml" -Method Post -Headers $h -UseBasicParsing -TimeoutSec 180 | Out-Null; "PublishAllXml OK" }
catch { Write-Warning "publish fail: $($_.Exception.Message)" }
