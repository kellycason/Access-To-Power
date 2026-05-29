using System.Text.Json.Serialization;

namespace AccessToPower.Helper.Models;

/// <summary>
/// Mirrors src/types/manifest.ts MigrationPlan. Keep in sync.
/// </summary>
public sealed class MigrationPlan
{
    [JsonPropertyName("migrationJobId")] public string MigrationJobId { get; set; } = "";
    [JsonPropertyName("manifest")] public AccessSchemaManifest Manifest { get; set; } = new();
    [JsonPropertyName("tableMappings")] public List<TableMapping> TableMappings { get; set; } = new();
    [JsonPropertyName("resolveLookupsAfterLoad")] public bool ResolveLookupsAfterLoad { get; set; }
    [JsonPropertyName("strictRowValidation")] public bool StrictRowValidation { get; set; }
}

public sealed class TableMapping
{
    [JsonPropertyName("accessTable")] public string AccessTable { get; set; } = "";
    [JsonPropertyName("action")] public string Action { get; set; } = "Migrate";
    [JsonPropertyName("targetMode")] public string? TargetMode { get; set; }
    [JsonPropertyName("dataverseSchemaName")] public string DataverseSchemaName { get; set; } = "";
    [JsonPropertyName("dataverseDisplayName")] public string DataverseDisplayName { get; set; } = "";
    [JsonPropertyName("dataversePluralName")] public string DataversePluralName { get; set; } = "";
    [JsonPropertyName("dataverseEntitySetName")] public string? DataverseEntitySetName { get; set; }
    [JsonPropertyName("primaryNameAccessColumn")] public string? PrimaryNameAccessColumn { get; set; }
    [JsonPropertyName("fields")] public List<FieldMapping> Fields { get; set; } = new();
}

public sealed class FieldMapping
{
    [JsonPropertyName("accessTable")] public string AccessTable { get; set; } = "";
    [JsonPropertyName("accessColumn")] public string AccessColumn { get; set; } = "";
    [JsonPropertyName("action")] public string Action { get; set; } = "Map";
    [JsonPropertyName("targetMode")] public string? TargetMode { get; set; }
    [JsonPropertyName("dataverseSchemaName")] public string DataverseSchemaName { get; set; } = "";
    [JsonPropertyName("dataverseDisplayName")] public string DataverseDisplayName { get; set; } = "";
    [JsonPropertyName("dataverseType")] public string DataverseType { get; set; } = "String";
    [JsonPropertyName("maxLength")] public int? MaxLength { get; set; }
    [JsonPropertyName("precision")] public int? Precision { get; set; }
    [JsonPropertyName("isAlternateKey")] public bool IsAlternateKey { get; set; }
    [JsonPropertyName("isRequired")] public bool IsRequired { get; set; }
    [JsonPropertyName("lookupTarget")] public string? LookupTarget { get; set; }
    [JsonPropertyName("choiceOptions")] public List<ChoiceOption>? ChoiceOptions { get; set; }
    [JsonPropertyName("binaryMaxSizeKb")] public int? BinaryMaxSizeKb { get; set; }
}

public sealed class ChoiceOption
{
    [JsonPropertyName("value")] public int Value { get; set; }
    [JsonPropertyName("label")] public string Label { get; set; } = "";
}
