# Provisions the acp_* tables for Access to Power into the Kelly C - Low Code env.
# Idempotent: skips entities/attributes/option sets that already exist.
#
# Order matters in Dataverse metadata:
#   1. Create the entity (with its primary name attribute)
#   2. Create non-lookup attributes (String, Memo, Integer, BigInt, DateTime, Boolean, File)
#   3. Create local option-set (Picklist) attributes
#   4. Create N:1 relationships (which create the Lookup attribute on the child)
#   5. Add each entity to the AccessToPower solution
#   6. PublishAllXml
#
# Source of truth: dataverse/migration-schema.yml. The YAML is purely a spec;
# this script encodes the same shape in PowerShell to avoid a YAML parser dep.

[CmdletBinding()]
param(
    [string]$EnvUrl = "https://yourorg.crm.dynamics.com",
    [string]$SolutionUniqueName = "AccessToPower",
    [string]$PublisherPrefix = "acp",
    [int]$OptionValuePrefix = 75123
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Auth + headers
# ---------------------------------------------------------------------------
$token = az account get-access-token --resource $EnvUrl --query accessToken -o tsv
if (-not $token) { throw "Failed to acquire token for $EnvUrl. Run 'az login --tenant <tenant>' first." }

$Headers = @{
    Authorization                  = "Bearer $token"
    "Content-Type"                 = "application/json; charset=utf-8"
    "OData-MaxVersion"             = "4.0"
    "OData-Version"                = "4.0"
    Accept                         = "application/json"
    "MSCRM.SolutionUniqueName"     = $SolutionUniqueName
    Prefer                         = "return=representation"
}

function Invoke-Api {
    param(
        [Parameter(Mandatory)] [string]$Method,
        [Parameter(Mandatory)] [string]$Path,
        [object]$Body
    )
    $uri = if ($Path.StartsWith("http")) { $Path } else { "$EnvUrl/api/data/v9.2/$Path" }
    $params = @{ Method = $Method; Uri = $uri; Headers = $Headers; UseBasicParsing = $true }
    if ($null -ne $Body) {
        $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    }
    try {
        return Invoke-WebRequest @params
    } catch {
        $resp = $_.Exception.Response
        $body = ""
        if ($resp) {
            try {
                $s = $resp.GetResponseStream()
                $sr = New-Object System.IO.StreamReader($s)
                $body = $sr.ReadToEnd()
            } catch {}
        }
        throw "API call failed: $Method $uri`n$body`n$($_.Exception.Message)"
    }
}

function Test-EntityExists {
    param([string]$LogicalName)
    try {
        $null = Invoke-Api -Method GET -Path "EntityDefinitions(LogicalName='$LogicalName')?`$select=LogicalName"
        return $true
    } catch { return $false }
}

function Test-AttributeExists {
    param([string]$EntityLogicalName, [string]$AttrLogicalName)
    try {
        $null = Invoke-Api -Method GET -Path "EntityDefinitions(LogicalName='$EntityLogicalName')/Attributes(LogicalName='$AttrLogicalName')?`$select=LogicalName"
        return $true
    } catch { return $false }
}

function New-LocalizedLabel {
    param([string]$Text)
    @{
        "@odata.type"            = "Microsoft.Dynamics.CRM.Label"
        LocalizedLabels          = @(@{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                Label         = $Text
                LanguageCode  = 1033
            })
    }
}

# ---------------------------------------------------------------------------
# Entity creation
# ---------------------------------------------------------------------------
function New-AcpEntity {
    param(
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$DisplayCollectionName,
        [string]$Description,
        [string]$OwnershipType,
        [string]$PrimaryNameSchema,
        [string]$PrimaryNameDisplay,
        [int]$PrimaryNameMaxLength = 200
    )
    $logical = $SchemaName.ToLowerInvariant()
    if (Test-EntityExists -LogicalName $logical) {
        Write-Host "  [skip] Entity $logical already exists"
        return
    }

    $body = @{
        "@odata.type"           = "Microsoft.Dynamics.CRM.EntityMetadata"
        SchemaName              = $SchemaName
        LogicalName             = $logical
        DisplayName             = (New-LocalizedLabel $DisplayName)
        DisplayCollectionName   = (New-LocalizedLabel $DisplayCollectionName)
        Description             = (New-LocalizedLabel $Description)
        OwnershipType           = $OwnershipType
        HasActivities           = $false
        HasNotes                = $true
        IsActivity              = $false
        Attributes              = @(
            @{
                "@odata.type"     = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
                SchemaName        = $PrimaryNameSchema
                LogicalName       = $PrimaryNameSchema.ToLowerInvariant()
                DisplayName       = (New-LocalizedLabel $PrimaryNameDisplay)
                RequiredLevel     = @{ Value = "ApplicationRequired" }
                MaxLength         = $PrimaryNameMaxLength
                FormatName        = @{ Value = "Text" }
                IsPrimaryName     = $true
            }
        )
    }
    Write-Host "  [create] Entity $logical"
    Invoke-Api -Method POST -Path "EntityDefinitions" -Body $body | Out-Null
}

# ---------------------------------------------------------------------------
# Attribute creation
# ---------------------------------------------------------------------------
function New-AcpAttribute {
    param(
        [string]$EntitySchema,
        [hashtable]$Attr  # { schemaName, displayName, type, maxLength?, options?, target?, isRequired?, description? }
    )
    $entityLogical = $EntitySchema.ToLowerInvariant()
    $attrLogical = $Attr.schemaName.ToLowerInvariant()
    if (Test-AttributeExists -EntityLogicalName $entityLogical -AttrLogicalName $attrLogical) {
        Write-Host "    [skip] $entityLogical.$attrLogical"
        return
    }

    $reqLevel = if ($Attr.isRequired) { "ApplicationRequired" } else { "None" }
    $body = $null

    switch ($Attr.type) {
        "String" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                MaxLength      = ($Attr.maxLength ?? 100)
                FormatName     = @{ Value = "Text" }
            }
        }
        "Memo" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.MemoAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                MaxLength      = ($Attr.maxLength ?? 4000)
                Format         = "TextArea"
            }
        }
        "Integer" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.IntegerAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                Format         = "None"
                MinValue       = -2147483648
                MaxValue       = 2147483647
            }
        }
        "BigInt" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.BigIntAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
            }
        }
        "DateTime" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                Format         = "DateAndTime"
                DateTimeBehavior = @{ Value = "UserLocal" }
            }
        }
        "Boolean" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.BooleanAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                DefaultValue   = $false
                OptionSet      = @{
                    "@odata.type" = "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata"
                    TrueOption    = @{ Value = 1; Label = (New-LocalizedLabel "Yes") }
                    FalseOption   = @{ Value = 0; Label = (New-LocalizedLabel "No") }
                }
            }
        }
        "File" {
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.FileAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                MaxSizeInKB    = 131072  # 128 MB cap
            }
        }
        "Choice" {
            $options = @()
            foreach ($o in $Attr.options) {
                $options += @{
                    Value = $o.value
                    Label = (New-LocalizedLabel $o.label)
                }
            }
            $body = @{
                "@odata.type"  = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata"
                SchemaName     = $Attr.schemaName
                LogicalName    = $attrLogical
                DisplayName    = (New-LocalizedLabel $Attr.displayName)
                RequiredLevel  = @{ Value = $reqLevel }
                OptionSet      = @{
                    "@odata.type"          = "Microsoft.Dynamics.CRM.OptionSetMetadata"
                    IsGlobal               = $false
                    OptionSetType          = "Picklist"
                    Options                = $options
                }
            }
        }
        "Lookup" {
            # Lookups are created via the relationships endpoint, handled separately.
            return
        }
        default {
            throw "Unsupported attribute type: $($Attr.type) for $($Attr.schemaName)"
        }
    }

    Write-Host "    [create] $entityLogical.$attrLogical ($($Attr.type))"
    Invoke-Api -Method POST -Path "EntityDefinitions(LogicalName='$entityLogical')/Attributes" -Body $body | Out-Null
}

# ---------------------------------------------------------------------------
# Lookup / N:1 relationship creation
# ---------------------------------------------------------------------------
function New-AcpLookup {
    param(
        [string]$ChildEntity,
        [string]$ParentEntity,
        [hashtable]$Attr   # { schemaName, displayName, isRequired? }
    )
    $childLogical = $ChildEntity.ToLowerInvariant()
    $parentLogical = $ParentEntity.ToLowerInvariant()
    $attrLogical = $Attr.schemaName.ToLowerInvariant()
    if (Test-AttributeExists -EntityLogicalName $childLogical -AttrLogicalName $attrLogical) {
        Write-Host "    [skip] lookup $childLogical.$attrLogical"
        return
    }

    $relSchemaName = "${PublisherPrefix}_${parentLogical}_${childLogical}_$($attrLogical)"
    if ($relSchemaName.Length -gt 100) { $relSchemaName = $relSchemaName.Substring(0, 100) }

    $reqLevel = if ($Attr.isRequired) { "ApplicationRequired" } else { "None" }

    $body = @{
        "@odata.type"            = "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata"
        SchemaName               = $relSchemaName
        ReferencedEntity         = $parentLogical
        ReferencingEntity        = $childLogical
        Lookup                   = @{
            "@odata.type"  = "Microsoft.Dynamics.CRM.LookupAttributeMetadata"
            SchemaName     = $Attr.schemaName
            LogicalName    = $attrLogical
            DisplayName    = (New-LocalizedLabel $Attr.displayName)
            RequiredLevel  = @{ Value = $reqLevel }
        }
        AssociatedMenuConfiguration = @{
            Behavior = "UseCollectionName"
            Group    = "Details"
            Label    = (New-LocalizedLabel ($ChildEntity -replace '^acp_', ''))
            Order    = 10000
        }
        CascadeConfiguration = @{
            Assign   = "NoCascade"
            Delete   = "RemoveLink"
            Merge    = "NoCascade"
            Reparent = "NoCascade"
            Share    = "NoCascade"
            Unshare  = "NoCascade"
        }
    }

    Write-Host "    [create] lookup $childLogical.$attrLogical -> $parentLogical"
    Invoke-Api -Method POST -Path "RelationshipDefinitions" -Body $body | Out-Null
}

# ---------------------------------------------------------------------------
# Add entity to solution
# ---------------------------------------------------------------------------
function Add-EntityToSolution {
    param([string]$EntityLogicalName)
    $body = @{
        ComponentId      = (Invoke-Api -Method GET -Path "EntityDefinitions(LogicalName='$EntityLogicalName')?`$select=MetadataId" |
                            Select-Object -ExpandProperty Content | ConvertFrom-Json).MetadataId
        ComponentType    = 1   # Entity
        SolutionUniqueName = $SolutionUniqueName
        AddRequiredComponents = $false
        DoNotIncludeSubcomponents = $false
    }
    try {
        Invoke-Api -Method POST -Path "AddSolutionComponent" -Body $body | Out-Null
        Write-Host "  [solution] added $EntityLogicalName"
    } catch {
        Write-Host "  [solution] (already present or failed) $EntityLogicalName"
    }
}

# ---------------------------------------------------------------------------
# Schema definition (mirrors dataverse/migration-schema.yml)
# ---------------------------------------------------------------------------
$tables = @(
    @{
        SchemaName            = "acp_MigrationJob"
        DisplayName           = "Migration Job"
        DisplayCollectionName = "Migration Jobs"
        Description           = "One end-to-end Access-to-Dataverse migration run."
        OwnershipType         = "UserOwned"
        PrimaryNameSchema     = "acp_Name"
        PrimaryNameDisplay    = "Name"
        Attributes            = @(
            @{ schemaName = "acp_Status"; displayName = "Status"; type = "Choice"; options = @(
                @{value=1;label="Draft"}, @{value=2;label="Scanning"}, @{value=3;label="Mapping"},
                @{value=4;label="Ready to Migrate"}, @{value=5;label="Creating Schema"},
                @{value=6;label="Loading Data"}, @{value=7;label="Resolving Lookups"},
                @{value=8;label="Validating"}, @{value=9;label="Succeeded"},
                @{value=10;label="Partially Succeeded"}, @{value=11;label="Failed"}, @{value=12;label="Cancelled"}
            )}
            @{ schemaName = "acp_SourceFileName"; displayName = "Source File Name"; type = "String"; maxLength = 260 }
            @{ schemaName = "acp_SourceFileSize"; displayName = "Source File Size (bytes)"; type = "BigInt" }
            @{ schemaName = "acp_SourceSha256"; displayName = "Source SHA-256"; type = "String"; maxLength = 64 }
            @{ schemaName = "acp_Manifest"; displayName = "Manifest JSON"; type = "File" }
            @{ schemaName = "acp_Plan"; displayName = "Migration Plan JSON"; type = "File" }
            @{ schemaName = "acp_TargetSolutionName"; displayName = "Target Solution Unique Name"; type = "String"; maxLength = 100 }
            @{ schemaName = "acp_TargetPublisherPrefix"; displayName = "Target Publisher Prefix"; type = "String"; maxLength = 8 }
            @{ schemaName = "acp_TableCount"; displayName = "Table Count"; type = "Integer" }
            @{ schemaName = "acp_RowCount"; displayName = "Row Count (Expected)"; type = "BigInt" }
            @{ schemaName = "acp_RowsMigrated"; displayName = "Rows Migrated"; type = "BigInt" }
            @{ schemaName = "acp_IssuesCount"; displayName = "Issues Count"; type = "Integer" }
            @{ schemaName = "acp_StartedOn"; displayName = "Started On"; type = "DateTime" }
            @{ schemaName = "acp_CompletedOn"; displayName = "Completed On"; type = "DateTime" }
        )
        Lookups               = @()
    }
    @{
        SchemaName            = "acp_MigrationTable"
        DisplayName           = "Migration Table"
        DisplayCollectionName = "Migration Tables"
        Description           = "One Access table being migrated under a job."
        OwnershipType         = "UserOwned"
        PrimaryNameSchema     = "acp_Name"
        PrimaryNameDisplay    = "Name"
        Attributes            = @(
            @{ schemaName = "acp_AccessTableName"; displayName = "Access Table Name"; type = "String"; maxLength = 128; isRequired = $true }
            @{ schemaName = "acp_DataverseSchemaName"; displayName = "Dataverse Schema Name"; type = "String"; maxLength = 128 }
            @{ schemaName = "acp_Action"; displayName = "Action"; type = "Choice"; options = @(
                @{value=1;label="Migrate"}, @{value=2;label="Skip"}
            )}
            @{ schemaName = "acp_Status"; displayName = "Status"; type = "Choice"; options = @(
                @{value=1;label="Pending"}, @{value=2;label="Schema Created"}, @{value=3;label="Loading"},
                @{value=4;label="Loaded"}, @{value=5;label="Lookups Resolved"}, @{value=6;label="Validated"},
                @{value=7;label="Skipped"}, @{value=8;label="Failed"}
            )}
            @{ schemaName = "acp_RowsExpected"; displayName = "Rows Expected"; type = "BigInt" }
            @{ schemaName = "acp_RowsLoaded"; displayName = "Rows Loaded"; type = "BigInt" }
            @{ schemaName = "acp_RowsFailed"; displayName = "Rows Failed"; type = "BigInt" }
            @{ schemaName = "acp_IdMap"; displayName = "ID Map (Access PK to Dataverse GUID)"; type = "File" }
        )
        Lookups               = @(
            @{ ParentEntity = "acp_migrationjob"; Attr = @{ schemaName = "acp_JobId"; displayName = "Migration Job"; isRequired = $true } }
        )
    }
    @{
        SchemaName            = "acp_MigrationColumn"
        DisplayName           = "Migration Column"
        DisplayCollectionName = "Migration Columns"
        Description           = "One Access column mapping decision under a migration table."
        OwnershipType         = "UserOwned"
        PrimaryNameSchema     = "acp_Name"
        PrimaryNameDisplay    = "Name"
        Attributes            = @(
            @{ schemaName = "acp_AccessColumnName"; displayName = "Access Column Name"; type = "String"; maxLength = 128 }
            @{ schemaName = "acp_AccessDataType"; displayName = "Access Data Type"; type = "String"; maxLength = 32 }
            @{ schemaName = "acp_DataverseSchemaName"; displayName = "Dataverse Schema Name"; type = "String"; maxLength = 128 }
            @{ schemaName = "acp_DataverseType"; displayName = "Dataverse Type"; type = "String"; maxLength = 32 }
            @{ schemaName = "acp_Action"; displayName = "Action"; type = "Choice"; options = @(
                @{value=1;label="Map"}, @{value=2;label="Skip"}
            )}
            @{ schemaName = "acp_IsPrimaryKey"; displayName = "Is Primary Key"; type = "Boolean" }
            @{ schemaName = "acp_IsAlternateKey"; displayName = "Is Alternate Key"; type = "Boolean" }
            @{ schemaName = "acp_IsRequired"; displayName = "Is Required"; type = "Boolean" }
            @{ schemaName = "acp_MaxLength"; displayName = "Max Length"; type = "Integer" }
            @{ schemaName = "acp_Precision"; displayName = "Precision"; type = "Integer" }
            @{ schemaName = "acp_LookupTarget"; displayName = "Lookup Target"; type = "String"; maxLength = 128 }
        )
        Lookups               = @(
            @{ ParentEntity = "acp_migrationtable"; Attr = @{ schemaName = "acp_TableId"; displayName = "Migration Table"; isRequired = $true } }
        )
    }
    @{
        SchemaName            = "acp_FieldMappingDecision"
        DisplayName           = "Field Mapping Decision"
        DisplayCollectionName = "Field Mapping Decisions"
        Description           = "Persisted user decisions per Access-type to Dataverse-type."
        OwnershipType         = "OrganizationOwned"
        PrimaryNameSchema     = "acp_Name"
        PrimaryNameDisplay    = "Name"
        Attributes            = @(
            @{ schemaName = "acp_AccessDataType"; displayName = "Access Data Type"; type = "String"; maxLength = 32 }
            @{ schemaName = "acp_RecommendedDataverseType"; displayName = "Recommended Dataverse Type"; type = "String"; maxLength = 32 }
            @{ schemaName = "acp_Notes"; displayName = "Notes"; type = "Memo" }
        )
        Lookups               = @()
    }
    @{
        SchemaName            = "acp_MigrationIssue"
        DisplayName           = "Migration Issue"
        DisplayCollectionName = "Migration Issues"
        Description           = "Remediation item discovered during scan / load / validate."
        OwnershipType         = "UserOwned"
        PrimaryNameSchema     = "acp_Name"
        PrimaryNameDisplay    = "Summary"
        Attributes            = @(
            @{ schemaName = "acp_Severity"; displayName = "Severity"; type = "Choice"; options = @(
                @{value=1;label="Info"}, @{value=2;label="Warning"}, @{value=3;label="Error"}
            )}
            @{ schemaName = "acp_Category"; displayName = "Category"; type = "String"; maxLength = 64 }
            @{ schemaName = "acp_Table"; displayName = "Table"; type = "String"; maxLength = 128 }
            @{ schemaName = "acp_Column"; displayName = "Column"; type = "String"; maxLength = 128 }
            @{ schemaName = "acp_RowOrdinal"; displayName = "Row Ordinal"; type = "BigInt" }
            @{ schemaName = "acp_Message"; displayName = "Message"; type = "Memo" }
        )
        Lookups               = @(
            @{ ParentEntity = "acp_migrationjob"; Attr = @{ schemaName = "acp_JobId"; displayName = "Migration Job"; isRequired = $true } }
        )
    }
    @{
        SchemaName            = "acp_MigrationLog"
        DisplayName           = "Migration Log"
        DisplayCollectionName = "Migration Logs"
        Description           = "Time-ordered execution log."
        OwnershipType         = "UserOwned"
        PrimaryNameSchema     = "acp_Name"
        PrimaryNameDisplay    = "Message"
        Attributes            = @(
            @{ schemaName = "acp_Level"; displayName = "Level"; type = "Choice"; options = @(
                @{value=1;label="Debug"}, @{value=2;label="Info"}, @{value=3;label="Warn"}, @{value=4;label="Error"}
            )}
            @{ schemaName = "acp_Source"; displayName = "Source"; type = "String"; maxLength = 64 }
            @{ schemaName = "acp_Details"; displayName = "Details"; type = "Memo" }
        )
        Lookups               = @(
            @{ ParentEntity = "acp_migrationjob"; Attr = @{ schemaName = "acp_JobId"; displayName = "Migration Job"; isRequired = $true } }
        )
    }
)

# ---------------------------------------------------------------------------
# Pass 1: create entities
# ---------------------------------------------------------------------------
Write-Host "`n=== Pass 1: Entities ==="
foreach ($t in $tables) {
    New-AcpEntity `
        -SchemaName $t.SchemaName `
        -DisplayName $t.DisplayName `
        -DisplayCollectionName $t.DisplayCollectionName `
        -Description $t.Description `
        -OwnershipType $t.OwnershipType `
        -PrimaryNameSchema $t.PrimaryNameSchema `
        -PrimaryNameDisplay $t.PrimaryNameDisplay
}

# ---------------------------------------------------------------------------
# Pass 2: non-lookup attributes
# ---------------------------------------------------------------------------
Write-Host "`n=== Pass 2: Attributes ==="
foreach ($t in $tables) {
    Write-Host "  Entity: $($t.SchemaName.ToLowerInvariant())"
    foreach ($a in $t.Attributes) {
        New-AcpAttribute -EntitySchema $t.SchemaName -Attr $a
    }
}

# ---------------------------------------------------------------------------
# Pass 3: lookups / relationships
# ---------------------------------------------------------------------------
Write-Host "`n=== Pass 3: Lookups ==="
foreach ($t in $tables) {
    if ($t.Lookups.Count -gt 0) {
        Write-Host "  Entity: $($t.SchemaName.ToLowerInvariant())"
        foreach ($lk in $t.Lookups) {
            New-AcpLookup -ChildEntity $t.SchemaName -ParentEntity $lk.ParentEntity -Attr $lk.Attr
        }
    }
}

# ---------------------------------------------------------------------------
# Pass 4: add entities to solution
# ---------------------------------------------------------------------------
Write-Host "`n=== Pass 4: Solution membership ==="
foreach ($t in $tables) {
    Add-EntityToSolution -EntityLogicalName $t.SchemaName.ToLowerInvariant()
}

# ---------------------------------------------------------------------------
# Pass 5: publish
# ---------------------------------------------------------------------------
Write-Host "`n=== Pass 5: PublishAllXml ==="
Invoke-Api -Method POST -Path "PublishAllXml" -Body @{} | Out-Null
Write-Host "Done."
