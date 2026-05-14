$ErrorActionPreference = "Stop"
$envUrl = "https://yourorg.crm.dynamics.com"
$token = az account get-access-token --resource $envUrl --query accessToken -o tsv
$hd = @{
    Authorization        = "Bearer $token"
    "Content-Type"       = "application/json; charset=utf-8"
    "OData-MaxVersion"   = "4.0"
    "OData-Version"      = "4.0"
    Accept               = "application/json"
    Prefer               = "return=representation"
}

# Publisher
$pub = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/publishers?`$filter=uniquename eq 'accesstopower'&`$select=publisherid,uniquename,customizationprefix" -Headers $hd
if ($pub.value.Count -gt 0) {
    $pubId = $pub.value[0].publisherid
    Write-Host "Publisher exists: $pubId prefix=$($pub.value[0].customizationprefix)"
} else {
    $pubBody = @{
        uniquename                     = "accesstopower"
        friendlyname                   = "Access to Power"
        description                    = "Publisher for the Access to Power migration tool"
        customizationprefix            = "acp"
        customizationoptionvalueprefix = 75123
    } | ConvertTo-Json
    $newPub = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/publishers" -Method Post -Headers $hd -Body $pubBody
    $pubId = $newPub.publisherid
    Write-Host "Created publisher: $pubId prefix=$($newPub.customizationprefix)"
}

# Solution
$sol = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/solutions?`$filter=uniquename eq 'AccessToPower'&`$select=solutionid,uniquename" -Headers $hd
if ($sol.value.Count -gt 0) {
    Write-Host "Solution exists: $($sol.value[0].solutionid)"
} else {
    $solBody = @{
        uniquename                = "AccessToPower"
        friendlyname              = "Access to Power"
        description               = "Migration tool for Microsoft Access databases to Dataverse"
        version                   = "0.1.0.0"
        "publisherid@odata.bind"  = "/publishers($pubId)"
    } | ConvertTo-Json
    $newSol = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/solutions" -Method Post -Headers $hd -Body $solBody
    Write-Host "Created solution: $($newSol.solutionid)"
}
