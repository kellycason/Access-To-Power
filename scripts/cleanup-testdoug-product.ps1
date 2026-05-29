param([string]$EnvUrl = "https://yourorg.crm.dynamics.com")

$ErrorActionPreference = 'Continue'
$envUrl = $EnvUrl
$tok = az account get-access-token --resource $envUrl --query accessToken -o tsv
$hRead  = @{ Authorization="Bearer $tok"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0"; Accept="application/json" }
$hWrite = @{ Authorization="Bearer $tok"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0"; "Content-Type"="application/json"; "If-Match"="*" }

$attrs = @('testdoug_categoryid','testdoug_supplierid','testdoug_unitsinstock','testdoug_discontinued')
$attrPattern = '(?:' + ($attrs -join '|') + ')'

# --- 1. Strip refs from PDS Product form ---
$formId = '7a91fa6b-6fff-ef11-bae2-000d3a319f57'
Write-Host "===== Cleaning form PDS Product ($formId) =====" -ForegroundColor Cyan
$form = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/systemforms($formId)?`$select=formxml,name" -Headers $hRead
$origLen = $form.formxml.Length
$xml = [xml]$form.formxml
$removed = 0

# Remove any <control ...> whose datafieldname matches; also any <cell> that has no controls left
$ns = New-Object Xml.XmlNamespaceManager($xml.NameTable)
$controls = $xml.SelectNodes("//control[@datafieldname]")
foreach ($c in @($controls)) {
  $df = $c.GetAttribute('datafieldname')
  if ($df -match "^$attrPattern$") {
    $cell = $c.ParentNode
    # remove the cell entirely (each control sits in its own cell typically)
    if ($cell -and $cell.LocalName -eq 'cell') {
      [void]$cell.ParentNode.RemoveChild($cell)
    } else {
      [void]$c.ParentNode.RemoveChild($c)
    }
    $removed++
    Write-Host "  removed control $df" -ForegroundColor Yellow
  }
}

# Also strip any leftover <Header> labels or attribute-references via raw regex sweep as belt-and-suspenders
$newFormXml = $xml.OuterXml
$newFormXml = [regex]::Replace($newFormXml, '<labels>\s*<label[^>]*description="[^"]*(?:CategoryID|SupplierID|UnitsInStock|Discontinued)[^"]*"[^/]*/>\s*</labels>', '', 'IgnoreCase')

if ($removed -gt 0 -or $newFormXml.Length -ne $origLen) {
  $body = @{ formxml = $newFormXml } | ConvertTo-Json -Compress
  try {
    Invoke-WebRequest -Uri "$envUrl/api/data/v9.2/systemforms($formId)" -Method Patch -Headers $hWrite -Body $body -UseBasicParsing -ErrorAction Stop | Out-Null
    Write-Host "  OK    PATCH form ($removed controls removed, len $origLen -> $($newFormXml.Length))" -ForegroundColor Green
  } catch {
    Write-Host "  FAIL  PATCH form: $($_.ErrorDetails.Message)" -ForegroundColor Red
  }
} else {
  Write-Host "  no changes to form" -ForegroundColor DarkGray
}

# --- 2. Strip refs from Product Lookup View ---
$viewId = '8ba625b2-6a2a-4735-bab2-0c74ae8442a4'
Write-Host ""
Write-Host "===== Cleaning view Product Lookup View ($viewId) =====" -ForegroundColor Cyan
$view = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/savedqueries($viewId)?`$select=fetchxml,layoutxml,name" -Headers $hRead

$fetch = [xml]$view.fetchxml
$layout = [xml]$view.layoutxml
$rmF = 0; $rmL = 0
foreach ($a in @($fetch.SelectNodes("//attribute[@name]"))) {
  if ($a.GetAttribute('name') -match "^$attrPattern$") { [void]$a.ParentNode.RemoveChild($a); $rmF++ }
}
foreach ($o in @($fetch.SelectNodes("//order[@attribute]"))) {
  if ($o.GetAttribute('attribute') -match "^$attrPattern$") { [void]$o.ParentNode.RemoveChild($o); $rmF++ }
}
foreach ($c in @($layout.SelectNodes("//cell[@name]"))) {
  if ($c.GetAttribute('name') -match "^$attrPattern$") { [void]$c.ParentNode.RemoveChild($c); $rmL++ }
}

if ($rmF -gt 0 -or $rmL -gt 0) {
  $body = @{ fetchxml = $fetch.OuterXml; layoutxml = $layout.OuterXml } | ConvertTo-Json -Compress
  try {
    Invoke-WebRequest -Uri "$envUrl/api/data/v9.2/savedqueries($viewId)" -Method Patch -Headers $hWrite -Body $body -UseBasicParsing -ErrorAction Stop | Out-Null
    Write-Host "  OK    PATCH view ($rmF fetch + $rmL layout entries removed)" -ForegroundColor Green
  } catch {
    Write-Host "  FAIL  PATCH view: $($_.ErrorDetails.Message)" -ForegroundColor Red
  }
} else {
  Write-Host "  no changes to view" -ForegroundColor DarkGray
}

# --- 3. PublishAllXml so the metadata cache forgets these references ---
Write-Host ""
Write-Host "===== PublishAllXml (after form/view cleanup) =====" -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/PublishAllXml" -Method POST -Headers $hWrite -Body "{}" -ErrorAction Stop
  Write-Host "  OK" -ForegroundColor Green
} catch { Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red }

function DelUri([string]$uri) {
  try {
    Invoke-WebRequest -Uri "$envUrl/api/data/v9.2/$uri" -Method Delete -Headers $hWrite -UseBasicParsing -ErrorAction Stop | Out-Null
    Write-Host "  OK    DELETE $uri" -ForegroundColor Green; return $true
  } catch {
    Write-Host "  FAIL  DELETE $uri" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host "         $($_.ErrorDetails.Message)" -ForegroundColor DarkRed }
    return $false
  }
}

# --- 4. Delete relationships (this auto-removes the lookup columns) ---
Write-Host ""
Write-Host "===== Delete relationships (kills lookup attrs) =====" -ForegroundColor Cyan
DelUri "RelationshipDefinitions(d4894808-cd5a-f111-bec5-001dd8097b43)" | Out-Null  # testdoug_category_product_testdoug_categoryid
DelUri "RelationshipDefinitions(e944480e-cd5a-f111-bec5-001dd8097b43)" | Out-Null  # testdoug_supplier_product_testdoug_supplierid

# --- 5. Delete the remaining 2 plain attrs ---
Write-Host ""
Write-Host "===== Delete remaining product attrs =====" -ForegroundColor Cyan
DelUri "EntityDefinitions(LogicalName='product')/Attributes(LogicalName='testdoug_unitsinstock')" | Out-Null
DelUri "EntityDefinitions(LogicalName='product')/Attributes(LogicalName='testdoug_discontinued')" | Out-Null

# --- 6. Delete the 2 entities (now nothing references them) ---
Write-Host ""
Write-Host "===== Delete entities =====" -ForegroundColor Cyan
DelUri "EntityDefinitions(LogicalName='testdoug_category')" | Out-Null
DelUri "EntityDefinitions(LogicalName='testdoug_supplier')" | Out-Null

# --- 7. Final publish ---
Write-Host ""
Write-Host "===== PublishAllXml (final) =====" -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/PublishAllXml" -Method POST -Headers $hWrite -Body "{}" -ErrorAction Stop
  Write-Host "  OK" -ForegroundColor Green
} catch { Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host ""
Write-Host "===== DONE =====" -ForegroundColor Cyan
