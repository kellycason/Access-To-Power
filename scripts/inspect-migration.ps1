$envUrl = "https://yourorg.crm.dynamics.com"
$token  = az account get-access-token --resource $envUrl --query accessToken -o tsv
$h = @{ Authorization="Bearer $token"; Accept="application/json"
        "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }

$jobName = "mew again"
$jobUrl = "$envUrl/api/data/v9.2/acp_migrationjobs?`$filter=acp_name eq '$jobName'&`$select=acp_migrationjobid,acp_status,acp_targetsolutionname,acp_targetpublisherprefix,createdon,modifiedon"
$job = (Invoke-RestMethod -Uri $jobUrl -Headers $h).value[0]
if (-not $job) { Write-Error "Job not found"; exit 1 }
$jobId = $job.acp_migrationjobid
$prefix = $job.acp_targetpublisherprefix
$solution = $job.acp_targetsolutionname

"=== JOB ==="
"  id          $jobId"
"  status      $($job.acp_status)"
"  prefix      $prefix"
"  solution    $solution"
"  modified    $($job.modifiedon)"

"`n=== ANNOTATIONS ==="
$aUrl = "$envUrl/api/data/v9.2/annotations?`$select=annotationid,filename,filesize,createdon&`$filter=_objectid_value eq $jobId&`$orderby=createdon"
$ann = (Invoke-RestMethod -Uri $aUrl -Headers $h).value
$ann | Format-Table filename,filesize,createdon -AutoSize

"`n=== PUBLISHER ==="
$pUrl = "$envUrl/api/data/v9.2/publishers?`$filter=customizationprefix eq '$prefix'&`$select=publisherid,uniquename,friendlyname,customizationprefix,customizationoptionvalueprefix"
(Invoke-RestMethod -Uri $pUrl -Headers $h).value | Format-List uniquename,friendlyname,customizationprefix,customizationoptionvalueprefix

"`n=== SOLUTION ==="
$sUrl = "$envUrl/api/data/v9.2/solutions?`$filter=uniquename eq '$solution'&`$select=solutionid,uniquename,friendlyname,version,createdon&`$expand=publisherid(`$select=customizationprefix,friendlyname)"
$sol = (Invoke-RestMethod -Uri $sUrl -Headers $h).value[0]
$sol | Format-List uniquename,friendlyname,version,createdon
"  publisher: $($sol.publisherid.friendlyname) ($($sol.publisherid.customizationprefix))"
$solutionId = $sol.solutionid

"`n=== SOLUTION COMPONENTS ==="
$cUrl = "$envUrl/api/data/v9.2/solutioncomponents?`$filter=_solutionid_value eq $solutionId&`$select=componenttype,objectid"
$comp = (Invoke-RestMethod -Uri $cUrl -Headers $h).value
$comp | Group-Object componenttype | ForEach-Object { "  type $($_.Name) -> $($_.Count) component(s)" }

# Resolve entity component objectids to logical names
$entityIds = ($comp | Where-Object { $_.componenttype -eq 1 }).objectid
"`n=== TABLES IN SOLUTION ==="
foreach ($eid in $entityIds) {
  try {
    $eUrl = "$envUrl/api/data/v9.2/EntityDefinitions($eid)?`$select=LogicalName,SchemaName,DisplayName,DisplayCollectionName,PrimaryNameAttribute,IsCustomEntity"
    $e = Invoke-RestMethod -Uri $eUrl -Headers $h
    "  $($e.SchemaName)  (logical: $($e.LogicalName), primaryName: $($e.PrimaryNameAttribute))"
  } catch {
    "  (failed to resolve $eid): $($_.Exception.Message)"
  }
}

# Attributes that belong to the solution
$attrIds = ($comp | Where-Object { $_.componenttype -eq 2 }).objectid
"`n=== ATTRIBUTES IN SOLUTION ($($attrIds.Count)) ==="
foreach ($aid in $attrIds) {
  try {
    $aUrl2 = "$envUrl/api/data/v9.2/EntityDefinitions/Microsoft.Dynamics.CRM.RetrieveAttributeRequest(MetadataId=$aid)"
    # Simpler: iterate via direct attribute fetch with type discriminator
  } catch {}
}

# Relationships in solution
$relIds = ($comp | Where-Object { $_.componenttype -eq 10 }).objectid
"`n=== RELATIONSHIPS IN SOLUTION ($($relIds.Count)) ==="
foreach ($rid in $relIds) {
  try {
    $rUrl = "$envUrl/api/data/v9.2/RelationshipDefinitions($rid)?`$select=SchemaName,RelationshipType"
    $r = Invoke-RestMethod -Uri $rUrl -Headers $h
    "  $($r.SchemaName)  ($($r.RelationshipType))"
  } catch {
    "  (failed to resolve $rid)"
  }
}

# Per-table attribute counts
"`n=== ATTRIBUTES PER TABLE ==="
foreach ($eid in $entityIds) {
  try {
    $eUrl = "$envUrl/api/data/v9.2/EntityDefinitions($eid)?`$select=LogicalName&`$expand=Attributes(`$select=LogicalName,SchemaName,AttributeType,IsCustomAttribute)"
    $e = Invoke-RestMethod -Uri $eUrl -Headers $h
    $custom = $e.Attributes | Where-Object { $_.IsCustomAttribute -eq $true }
    "  $($e.LogicalName) -> $($custom.Count) custom attribute(s):"
    $custom | Sort-Object SchemaName | ForEach-Object { "      $($_.SchemaName)  [$($_.AttributeType)]" }
  } catch {
    "  $eid : $($_.Exception.Message)"
  }
}

"`n=== MIGRATION LOG (last 30 lines) ==="
$logAnn = $ann | Where-Object { $_.filename -eq 'migration-log.ndjson' }
if ($logAnn) {
  $body = (Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/annotations($($logAnn.annotationid))?`$select=documentbody" -Headers $h).documentbody
  if ($body) {
    $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($body))
    $lines = $text -split "`n" | Where-Object { $_.Trim() }
    "  total log lines: $($lines.Count)"
    $lines | Select-Object -Last 30 | ForEach-Object { "    $_" }
  } else { "  (empty)" }
} else { "  (no migration-log.ndjson)" }
