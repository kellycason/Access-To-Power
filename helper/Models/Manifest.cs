using System.Text.Json.Serialization;

namespace AccessToPower.Helper.Models;

/// <summary>
/// Mirrors src/types/manifest.ts AccessSchemaManifest. Keep in sync.
/// </summary>
public sealed class AccessSchemaManifest
{
    [JsonPropertyName("manifestVersion")]
    public string ManifestVersion { get; set; } = "1.0";

    [JsonPropertyName("migrationJobId")]
    public string MigrationJobId { get; set; } = "";

    [JsonPropertyName("jobName")]
    public string JobName { get; set; } = "";

    [JsonPropertyName("sourcePath")]
    public string SourcePath { get; set; } = "";

    [JsonPropertyName("sourceSize")]
    public long SourceSize { get; set; }

    [JsonPropertyName("sourceSha256")]
    public string? SourceSha256 { get; set; }

    [JsonPropertyName("capturedAt")]
    public string CapturedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");

    [JsonPropertyName("emittedBy")]
    public string EmittedBy { get; set; } = "DotNetHelper";

    [JsonPropertyName("emitterVersion")]
    public string EmitterVersion { get; set; } = "0.1.0";

    [JsonPropertyName("tables")]
    public List<AccessTable> Tables { get; set; } = new();

    [JsonPropertyName("relationships")]
    public List<AccessRelationship> Relationships { get; set; } = new();

    [JsonPropertyName("issues")]
    public List<ManifestIssue>? Issues { get; set; }
}

public sealed class AccessTable
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("rowCount")] public long RowCount { get; set; }
    [JsonPropertyName("rowsFile")] public string RowsFile { get; set; } = "";
    [JsonPropertyName("rowsSha256")] public string? RowsSha256 { get; set; }
    [JsonPropertyName("columns")] public List<AccessColumn> Columns { get; set; } = new();
    [JsonPropertyName("indexes")] public List<AccessIndex>? Indexes { get; set; }
    [JsonPropertyName("issues")] public List<ManifestIssue>? Issues { get; set; }
}

public sealed class AccessColumn
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("dataType")] public string DataType { get; set; } = "Unknown";
    [JsonPropertyName("maxLength")] public int? MaxLength { get; set; }
    [JsonPropertyName("precision")] public int? Precision { get; set; }
    [JsonPropertyName("scale")] public int? Scale { get; set; }
    [JsonPropertyName("isPrimaryKey")] public bool IsPrimaryKey { get; set; }
    [JsonPropertyName("isRequired")] public bool IsRequired { get; set; }
    [JsonPropertyName("isAutoNumber")] public bool IsAutoNumber { get; set; }
    [JsonPropertyName("defaultValue")] public string? DefaultValue { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("detectedDateOnly")] public bool? DetectedDateOnly { get; set; }
    [JsonPropertyName("detectedMaxDecimals")] public int? DetectedMaxDecimals { get; set; }
    [JsonPropertyName("issues")] public List<ManifestIssue>? Issues { get; set; }
}

public sealed class AccessIndex
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("columns")] public List<string> Columns { get; set; } = new();
    [JsonPropertyName("unique")] public bool Unique { get; set; }
}

public sealed class AccessRelationship
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("parentTable")] public string ParentTable { get; set; } = "";
    [JsonPropertyName("parentColumns")] public List<string> ParentColumns { get; set; } = new();
    [JsonPropertyName("childTable")] public string ChildTable { get; set; } = "";
    [JsonPropertyName("childColumns")] public List<string> ChildColumns { get; set; } = new();
    [JsonPropertyName("enforceReferentialIntegrity")] public bool EnforceReferentialIntegrity { get; set; }
    [JsonPropertyName("cascadeUpdate")] public bool CascadeUpdate { get; set; }
    [JsonPropertyName("cascadeDelete")] public bool CascadeDelete { get; set; }
}

public sealed class ManifestIssue
{
    [JsonPropertyName("severity")] public string Severity { get; set; } = "Info";
    [JsonPropertyName("category")] public string Category { get; set; } = "Other";
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("table")] public string? Table { get; set; }
    [JsonPropertyName("column")] public string? Column { get; set; }
    [JsonPropertyName("rowOrdinal")] public long? RowOrdinal { get; set; }
}
