$o = "https://yourorg.crm.dynamics.com"
$t = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$h = @{ Authorization="Bearer $t"; Accept="application/json"; "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }
$names = (Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions?`$filter=LogicalName eq 'acp_categories' or LogicalName eq 'acp_supplier' or LogicalName eq 'acp_suppliers' or LogicalName eq 'acp_order' or LogicalName eq 'acp_orders' or LogicalName eq 'product'&`$select=LogicalName,EntitySetName" -Headers $h).value
$names | Format-Table -AutoSize | Out-String | Write-Host
foreach ($n in $names) {
  try { $c = Invoke-RestMethod -Uri "$o/api/data/v9.2/$($n.EntitySetName)/`$count" -Headers $h; Write-Host "$($n.LogicalName) ($($n.EntitySetName)): $c rows" } catch { Write-Host "$($n.LogicalName): ERR" }
}
