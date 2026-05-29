param([string]$EnvUrl = "https://yourorg.crm.dynamics.com")

$ErrorActionPreference = 'Continue'
$envUrl = $EnvUrl
$tok = az account get-access-token --resource $envUrl --query accessToken -o tsv
$hRead  = @{ Authorization="Bearer $tok"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0"; Accept="application/json" }
$hWrite = @{ Authorization="Bearer $tok"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0"; "Content-Type"="application/json"; "If-Match"="*" }

function DelUri([string]$uri) {
  try {
    $r = Invoke-WebRequest -Uri "$envUrl/api/data/v9.2/$uri" -Method Delete -Headers $hWrite -UseBasicParsing -ErrorAction Stop
    Write-Host "  OK    DELETE $uri" -ForegroundColor Green
    return $true
  } catch {
    $msg = $_.ErrorDetails.Message
    if ($msg) { Write-Host "  FAIL  DELETE $uri" -ForegroundColor Red; Write-Host "         $msg" -ForegroundColor DarkRed }
    else { Write-Host "  FAIL  DELETE $uri  : $($_.Exception.Message)" -ForegroundColor Red }
    return $false
  }
}

function DelEntityIfExists([string]$logical) {
  try {
    Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='$logical')?`$select=LogicalName" -Headers $hRead -ErrorAction Stop | Out-Null
  } catch { Write-Host "  skip  entity $logical not found" -ForegroundColor DarkGray; return }
  DelUri "EntityDefinitions(LogicalName='$logical')" | Out-Null
}

function DelAttrIfExists([string]$ent, [string]$attr) {
  try {
    Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='$ent')/Attributes(LogicalName='$attr')?`$select=LogicalName" -Headers $hRead -ErrorAction Stop | Out-Null
  } catch { Write-Host "  skip  attr $ent.$attr not found" -ForegroundColor DarkGray; return }
  DelUri "EntityDefinitions(LogicalName='$ent')/Attributes(LogicalName='$attr')" | Out-Null
}

function DelRowIfExists([string]$entitySet, [string]$id) {
  try {
    Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/$entitySet($id)?`$select=$($entitySet.TrimEnd('s'))id" -Headers $hRead -ErrorAction Stop | Out-Null
  } catch { Write-Host "  skip  $entitySet($id) not found" -ForegroundColor DarkGray; return }
  DelUri "$entitySet($id)" | Out-Null
}

Write-Host "===== Orphan entities from FileTestD/filetest3/FileTest2 (surveyrespons already gone) =====" -ForegroundColor Cyan
DelEntityIfExists 'filetesd_geosite'
DelEntityIfExists 'filetesd_sitestatus'
DelEntityIfExists 'filetesc_geosite'
DelEntityIfExists 'filetesc_sitestatus'
DelEntityIfExists 'filetesb_geosite'
DelEntityIfExists 'filetesb_sitestatus'

Write-Host ""
Write-Host "===== FileTest (dup) job =====" -ForegroundColor Cyan
DelRowIfExists 'acp_migrationjobs' '65bb69f1-d55a-f111-bec5-001dd8097b43'

Write-Host ""
Write-Host "===== ChoiceField (survey -> geosite/sitestatus, then sol+pub+job) =====" -ForegroundColor Cyan
DelEntityIfExists 'choicefi_surveyrespons'
DelEntityIfExists 'choicefi_geosite'
DelEntityIfExists 'choicefi_sitestatus'
DelRowIfExists 'solutions' '97af9589-d05a-f111-bec5-001dd8097c02'
DelRowIfExists 'publishers' '91af9589-d05a-f111-bec5-001dd8097c02'
DelRowIfExists 'acp_migrationjobs' '95974024-d05a-f111-bec5-001dd8097d15'

Write-Host ""
Write-Host "===== TestDoug2 (appmodule, custom attrs on product, then custom entities) =====" -ForegroundColor Cyan
DelRowIfExists 'appmodules' '8273b2e6-cd5a-f111-bec5-001dd809796c'

# Drop relationships by deleting the lookup attrs first; then primitive attrs; then entities
DelAttrIfExists 'product' 'testdoug_categoryid'
DelAttrIfExists 'product' 'testdoug_supplierid'
DelAttrIfExists 'product' 'testdoug_unitsinstock'
DelAttrIfExists 'product' 'testdoug_discontinued'

# Orders likely references Category + Supplier, so delete it first
DelEntityIfExists 'testdoug_order'
DelEntityIfExists 'testdoug_category'
DelEntityIfExists 'testdoug_supplier'

DelRowIfExists 'solutions' '19517296-cc5a-f111-bec5-001dd8097b43'
DelRowIfExists 'publishers' '06517296-cc5a-f111-bec5-001dd8097b43'
DelRowIfExists 'acp_migrationjobs' '70a7a87a-cc5a-f111-bec5-001dd8097c02'

Write-Host ""
Write-Host "===== PublishAllXml =====" -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/PublishAllXml" -Method POST -Headers $hWrite -Body "{}" -ErrorAction Stop
  Write-Host "  OK    PublishAllXml" -ForegroundColor Green
} catch {
  Write-Host "  FAIL  PublishAllXml: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "===== DONE =====" -ForegroundColor Cyan
