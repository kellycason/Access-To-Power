$o = "https://yourorg.crm.dynamics.com"
$token = (az account get-access-token --resource $o | ConvertFrom-Json).accessToken
$hd = @{ Authorization = "Bearer $token"; Accept = "application/json"; "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0" }

Write-Host "--- 1. Author column types ---"
$la = (Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='calvinte_author')/Attributes?`$select=LogicalName,AttributeType" -Headers $hd).value
$la | Where-Object { $_.LogicalName -like 'calvinte_*' } | Sort-Object LogicalName | Format-Table LogicalName, AttributeType | Out-String | Write-Host

Write-Host "`n--- 2. Lastname StringAttributeMetadata detail ---"
try {
    $detail = Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='calvinte_author')/Attributes(LogicalName='calvinte_lastname')/Microsoft.Dynamics.CRM.StringAttributeMetadata?`$select=LogicalName,MaxLength,FormatName" -Headers $hd
    $detail | ConvertTo-Json -Depth 3 | Write-Host
} catch { Write-Host "Not a String: $($_.Exception.Message)" }
try {
    $detail2 = Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='calvinte_author')/Attributes(LogicalName='calvinte_lastname')/Microsoft.Dynamics.CRM.MemoAttributeMetadata?`$select=LogicalName,MaxLength,Format" -Headers $hd
    Write-Host "...also accessible as Memo:"; $detail2 | ConvertTo-Json -Depth 3 | Write-Host
} catch {}

Write-Host "`n--- 3. BookAuthor primary name + sample rows ---"
$ba = Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='calvinte_bookauthor')?`$select=PrimaryNameAttribute,EntitySetName,LogicalName" -Headers $hd
Write-Host "primaryname=$($ba.PrimaryNameAttribute) set=$($ba.EntitySetName)"
$sample = (Invoke-RestMethod -Uri "$o/api/data/v9.2/$($ba.EntitySetName)?`$top=3" -Headers $hd).value
$sample | ConvertTo-Json -Depth 2 | Write-Host

Write-Host "`n--- 4. All entities + their primary names (looking for blanks) ---"
$ents = @("calvinte_author","calvinte_book","calvinte_bookauthor","calvinte_bookcategory","calvinte_bookcategoryassignment","calvinte_loan","calvinte_loanevent","calvinte_patron","calvinte_patronaddress","calvinte_publisher")
foreach ($e in $ents) {
    $def = Invoke-RestMethod -Uri "$o/api/data/v9.2/EntityDefinitions(LogicalName='$e')?`$select=PrimaryNameAttribute,EntitySetName" -Headers $hd
    $pname = $def.PrimaryNameAttribute
    $rows = (Invoke-RestMethod -Uri "$o/api/data/v9.2/$($def.EntitySetName)?`$select=$pname&`$top=3" -Headers $hd).value
    $vals = $rows | ForEach-Object { if ($_.$pname) { $_.$pname } else { '<blank>' } }
    Write-Host ("{0,-40} pname={1,-22} samples={2}" -f $e, $pname, ($vals -join ' | '))
}
