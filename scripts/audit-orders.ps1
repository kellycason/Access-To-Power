$envUrl = "https://yourorg.crm.dynamics.com"
$token  = az account get-access-token --resource $envUrl --query accessToken -o tsv
$h = @{ Authorization="Bearer $token"; Accept="application/json"
        "OData-MaxVersion"="4.0"; "OData-Version"="4.0" }

"=== ACP_ORDERS attributes (raw) ==="
$url = "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='acp_orders')/Attributes?`$select=LogicalName,SchemaName,AttributeTypeName,AttributeType,IsCustomAttribute,IsValidForCreate"
(Invoke-RestMethod -Uri $url -Headers $h).value |
  Where-Object { $_.LogicalName -like "mewagain*" -or $_.LogicalName -like "acp_*" } |
  Sort-Object LogicalName |
  Format-Table LogicalName,SchemaName,@{N='Type';E={$_.AttributeTypeName.Value}},IsCustomAttribute -AutoSize

"`n=== Lookup mewagain_product details ==="
$lu = "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='acp_orders')/Attributes(LogicalName='mewagain_product')/Microsoft.Dynamics.CRM.LookupAttributeMetadata?`$select=LogicalName,SchemaName,Targets"
try { Invoke-RestMethod -Uri $lu -Headers $h | Format-List LogicalName,SchemaName,Targets } catch { $_.Exception.Message }

"`n=== mewagain_productName details ==="
$pn = "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='acp_orders')/Attributes(LogicalName='mewagain_productname')?`$select=LogicalName,SchemaName,AttributeType,IsCustomAttribute"
try { Invoke-RestMethod -Uri $pn -Headers $h | Format-List } catch { "  not retrievable: $($_.Exception.Message)" }

"`n=== Relationships on acp_orders ==="
$rels = "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='acp_orders')/ManyToOneRelationships?`$select=SchemaName,ReferencedEntity,ReferencingAttribute"
(Invoke-RestMethod -Uri $rels -Headers $h).value |
  Where-Object { $_.SchemaName -like "*mewagain*" -or $_.ReferencedEntity -eq 'product' } |
  Format-Table SchemaName,ReferencedEntity,ReferencingAttribute -AutoSize

"`n=== Solution components, ALL component types ==="
$sUrl = "$envUrl/api/data/v9.2/solutions?`$filter=uniquename eq 'mewagain'&`$select=solutionid"
$solutionId = (Invoke-RestMethod -Uri $sUrl -Headers $h).value[0].solutionid
$cUrl = "$envUrl/api/data/v9.2/solutioncomponents?`$filter=_solutionid_value eq $solutionId&`$select=componenttype,objectid,rootcomponentbehavior"
(Invoke-RestMethod -Uri $cUrl -Headers $h).value | Group-Object componenttype | Sort-Object Name | ForEach-Object { "  type $($_.Name): $($_.Count)" }

"`n=== Relationship presence by SchemaName ==="
$relUrl = "$envUrl/api/data/v9.2/RelationshipDefinitions?`$filter=SchemaName eq 'product_acp_orders_mewagain_product'&`$select=SchemaName,MetadataId,IsCustomRelationship,IsManaged"
try { (Invoke-RestMethod -Uri $relUrl -Headers $h).value | Format-List } catch { $_.Exception.Message }
