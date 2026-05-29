# Creates an Access database that intentionally exercises field shapes that
# show up in real customer files and are easy to miss with Northwind-style data.
#
# Patterns this exercises:
#   - DOUBLE latitude / longitude with 6+ decimal places
#   - SINGLE and DECIMAL / NUMERIC precision
#   - MEMO multiline and long text payloads
#   - Date-only and date+time values
#   - Boolean, Byte, Integer, Long, Currency, URL text, GUID-shaped text
#   - Normal lookup/FK table relationship
#   - Lookup Wizard-style value-list metadata on scalar fields (best effort)
#   - Multi-valued lookup/text and Attachment columns (best effort)
#   - OLE Object / Binary unsupported-type detection
#
# Requires Access Database Engine 2016 (x64). DAO-specific features are best
# effort because different machines expose different ACE/DAO COM versions.
#
# Usage:
#   .\create-edge-cases-accdb.ps1              # writes .\samples\edge-cases.accdb
#   .\create-edge-cases-accdb.ps1 -Force       # overwrite existing

[CmdletBinding()]
param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'edge-cases.accdb'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (Test-Path $OutFile) {
    if ($Force) { Remove-Item $OutFile -Force }
    else { throw "File exists: $OutFile. Re-run with -Force to overwrite." }
}
$dir = Split-Path $OutFile -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$connStr = "Provider=Microsoft.ACE.OLEDB.16.0;Data Source=$OutFile;Jet OLEDB:Engine Type=6;"
Write-Host "Creating $OutFile..." -ForegroundColor Cyan

$cat = New-Object -ComObject ADOX.Catalog
$cat.Create($connStr) | Out-Null
$cat = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

$conn = New-Object -ComObject ADODB.Connection
$conn.Open($connStr)

function Exec($sql) {
    Write-Verbose "SQL: $sql"
    $conn.Execute($sql) | Out-Null
}

function TryExec($description, $sql) {
    try {
        Exec $sql
        Write-Host "  Added $description" -ForegroundColor DarkGreen
        return $true
    } catch {
        Write-Host "  Skipped ${description}: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

function Esc($s) {
    if ($null -eq $s) { 'NULL' }
    else { "'" + ($s -replace "'", "''") + "'" }
}

function DateLit([DateTime]$d) { '#' + $d.ToString('yyyy-MM-dd HH:mm:ss') + '#' }

# ---- DDL --------------------------------------------------------------

Exec @"
CREATE TABLE SiteStatuses (
    StatusID       AUTOINCREMENT PRIMARY KEY,
    StatusName     TEXT(40) NOT NULL,
    SortOrder      BYTE
)
"@

Exec @"
CREATE TABLE GeoSites (
    SiteID          AUTOINCREMENT PRIMARY KEY,
    SiteCode        TEXT(20) NOT NULL,
    SiteName        TEXT(120) NOT NULL,
    Latitude        DOUBLE,
    Longitude       DOUBLE,
    ElevationMeters SINGLE,
    AnnualBudget    CURRENCY,
    ExternalGuid    TEXT(38),
    WebsiteUrl      TEXT(255),
    StatusID        LONG,
    IsPublic        BIT NOT NULL,
    CONSTRAINT fk_site_status FOREIGN KEY (StatusID) REFERENCES SiteStatuses(StatusID)
)
"@

Exec @"
CREATE TABLE SurveyResponses (
    ResponseID      AUTOINCREMENT PRIMARY KEY,
    SiteID          LONG NOT NULL,
    ResponseCode    TEXT(30) NOT NULL,
    VisitDate       DATETIME NOT NULL,
    VisitStartedAt  DATETIME NOT NULL,
    Rating          BYTE,
    Priority        LONG,
    Status          TEXT(30),
    MeasuredPh      DOUBLE,
    SampleDepth     SINGLE,
    IsVerified      BIT NOT NULL,
    Comments        MEMO,
    LongNarrative   MEMO,
    RichTextNotes   MEMO,
    RawPayload      LONGBINARY,
    CONSTRAINT fk_response_site FOREIGN KEY (SiteID) REFERENCES GeoSites(SiteID)
)
"@

# These ACE-specific column types are not available on every provider build.
# If the local engine supports them, the scanner should surface them as either
# unsupported/unknown or as columns needing manual choice/attachment handling.
$hasDecimal = TryExec 'DECIMAL AccuracyMeters field' "ALTER TABLE GeoSites ADD COLUMN AccuracyMeters DECIMAL(18,8)"
$hasLegacyPhoto = TryExec 'OLE Object-style LegacyPhoto binary field' "ALTER TABLE SurveyResponses ADD COLUMN LegacyPhoto LONGBINARY"
$hasTags = TryExec 'multi-valued Tags field' "ALTER TABLE SurveyResponses ADD COLUMN Tags TEXT(255) MULTIVALUE"
$hasAttachment = TryExec 'Attachment field' "ALTER TABLE SurveyResponses ADD COLUMN EvidenceFiles ATTACHMENT"

# ---- Lookup Wizard metadata (best effort via DAO) ---------------------

function AddLookupProperty($field, [string]$name, [int]$type, $value) {
    try {
        $field.Properties.Item($name).Value = $value
    } catch {
        $field.Properties.Append($field.CreateProperty($name, $type, $value))
    }
}

function ConfigureLookupWizardFields([string]$path, [bool]$tagsColumnExists) {
    $daoProgIds = @('DAO.DBEngine.160', 'DAO.DBEngine.150', 'DAO.DBEngine.140', 'DAO.DBEngine.120')
    $engine = $null
    foreach ($progId in $daoProgIds) {
        try { $engine = New-Object -ComObject $progId; break } catch {}
    }
    if (-not $engine) {
        Write-Host '  Skipped Lookup Wizard metadata: DAO DBEngine COM object not available.' -ForegroundColor Yellow
        return
    }

    # DAO data type constants used for property creation.
    $dbBoolean = 1
    $dbInteger = 3
    $dbText = 10
    $acComboBox = 111

    $db = $null
    try {
        $db = $engine.OpenDatabase($path)
        $responses = $db.TableDefs.Item('SurveyResponses')

        $statusField = $responses.Fields.Item('Status')
        AddLookupProperty $statusField 'DisplayControl' $dbInteger $acComboBox
        AddLookupProperty $statusField 'RowSourceType' $dbText 'Value List'
        AddLookupProperty $statusField 'RowSource' $dbText 'Proposed;Active;Retired;Needs Review'
        AddLookupProperty $statusField 'LimitToList' $dbBoolean $true
        AddLookupProperty $statusField 'ColumnCount' $dbInteger 1
        AddLookupProperty $statusField 'ListRows' $dbInteger 8

        $priorityField = $responses.Fields.Item('Priority')
        AddLookupProperty $priorityField 'DisplayControl' $dbInteger $acComboBox
        AddLookupProperty $priorityField 'RowSourceType' $dbText 'Value List'
        AddLookupProperty $priorityField 'RowSource' $dbText '1;Low;2;Normal;3;High;4;Critical'
        AddLookupProperty $priorityField 'LimitToList' $dbBoolean $true
        AddLookupProperty $priorityField 'ColumnCount' $dbInteger 2
        AddLookupProperty $priorityField 'BoundColumn' $dbInteger 1
        AddLookupProperty $priorityField 'ColumnWidths' $dbText '0in;1.25in'

        if ($tagsColumnExists) {
            try {
                $tagsField = $responses.Fields.Item('Tags')
                AddLookupProperty $tagsField 'DisplayControl' $dbInteger $acComboBox
                AddLookupProperty $tagsField 'RowSourceType' $dbText 'Value List'
                AddLookupProperty $tagsField 'RowSource' $dbText 'Water Quality;Habitat;Seasonal;Follow Up;Customer Report'
                AddLookupProperty $tagsField 'LimitToList' $dbBoolean $true
                AddLookupProperty $tagsField 'ColumnCount' $dbInteger 1
                AddLookupProperty $tagsField 'ListRows' $dbInteger 8
            } catch {
                Write-Host "  Tags lookup metadata skipped: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }

        Write-Host '  Added Lookup Wizard metadata for Status/Priority fields' -ForegroundColor DarkGreen
    } catch {
        Write-Host "  Skipped Lookup Wizard metadata: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        if ($db) { $db.Close() }
        $db = $null
        $engine = $null
        [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
    }
}

ConfigureLookupWizardFields $OutFile $hasTags

# ---- Seed -------------------------------------------------------------

$statuses = @('Proposed', 'Active', 'Retired', 'Needs Review')
for ($i = 0; $i -lt $statuses.Count; $i++) {
    Exec "INSERT INTO SiteStatuses (StatusName, SortOrder) VALUES ($(Esc $statuses[$i]), $($i + 1))"
}

function GetId($table, $col, $val) {
    $rs = $conn.Execute("SELECT * FROM $table WHERE $col = $(Esc $val)")
    if ($rs.EOF) { throw "Not found: $table.$col = $val" }
    $id = [int]$rs.Fields.Item(0).Value
    $rs.Close() | Out-Null
    return $id
}

$activeStatusId = GetId 'SiteStatuses' 'StatusName' 'Active'
$reviewStatusId = GetId 'SiteStatuses' 'StatusName' 'Needs Review'
$proposedStatusId = GetId 'SiteStatuses' 'StatusName' 'Proposed'

$sites = @(
    @{ Code='SEA-PIER-01'; Name='Pier 57 Sensor Cluster'; Lat=47.6062095; Long=-122.3420708; Elev=4.25; Acc=0.12345678; Budget=125000.55; Status=$activeStatusId; Public=1; Url='https://example.org/sites/sea-pier-01' },
    @{ Code='DEN-RIDGE-02'; Name='Ridge Observation Station'; Lat=39.7392358; Long=-104.9902510; Elev=1609.34; Acc=1.98765432; Budget=98000.10; Status=$reviewStatusId; Public=0; Url='https://example.org/sites/den-ridge-02' },
    @{ Code='MIA-BAY-03'; Name='Bay Intake Monitor'; Lat=25.7616798; Long=-80.1917902; Elev=1.75; Acc=0.00012345; Budget=211500.00; Status=$proposedStatusId; Public=1; Url='https://example.org/sites/mia-bay-03' }
)

foreach ($s in $sites) {
    $guid = [guid]::NewGuid().ToString('B')
    Exec "INSERT INTO GeoSites (SiteCode, SiteName, Latitude, Longitude, ElevationMeters, AnnualBudget, ExternalGuid, WebsiteUrl, StatusID, IsPublic) VALUES ($(Esc $s.Code), $(Esc $s.Name), $($s.Lat), $($s.Long), $($s.Elev), $($s.Budget), $(Esc $guid), $(Esc $s.Url), $($s.Status), $($s.Public))"
    if ($hasDecimal) {
        Exec "UPDATE GeoSites SET AccuracyMeters = $($s.Acc) WHERE SiteCode = $(Esc $s.Code)"
    }
}

$siteIds = @{}
foreach ($s in $sites) { $siteIds[$s.Code] = GetId 'GeoSites' 'SiteCode' $s.Code }

$longNarrative = @"
Line 1: This memo intentionally contains multiple paragraphs.

Line 3: The scanner and loader should preserve line breaks, punctuation, and long text.

Line 5: This block is repeated to push past ordinary short-text boundaries.
"@
for ($i = 1; $i -le 45; $i++) {
    $longNarrative += "`r`nRepeated memo sentence $i with coordinates, notes, and field observations."
}

$responses = @(
    @{ Site='SEA-PIER-01'; Code='R-SEA-001'; Visit='2026-05-01'; Started='2026-05-01 08:15:22'; Rating=5; Priority=3; Status='Active'; Ph=7.123456; Depth=2.5; Verified=1; Comments="First line`r`nSecond line`r`nThird line"; Rich='<div><strong>Rich text-ish</strong> note with <em>HTML</em>.</div>' },
    @{ Site='DEN-RIDGE-02'; Code='R-DEN-001'; Visit='2026-05-02'; Started='2026-05-02 14:45:10'; Rating=2; Priority=4; Status='Needs Review'; Ph=8.7654321; Depth=0.125; Verified=0; Comments='Short memo'; Rich='<p style="color:red">Outlier reading, review required.</p>' },
    @{ Site='MIA-BAY-03'; Code='R-MIA-001'; Visit='2026-05-03'; Started='2026-05-03 23:59:59'; Rating=4; Priority=2; Status='Proposed'; Ph=6.000001; Depth=9.875; Verified=1; Comments='Contains comma, quote, and apostrophe: "sample", O''Brien'; Rich='<ul><li>One</li><li>Two</li></ul>' }
)

foreach ($r in $responses) {
    $siteId = $siteIds[$r.Site]
    $visitDate = [DateTime]::Parse($r.Visit)
    $started = [DateTime]::Parse($r.Started)
    Exec "INSERT INTO SurveyResponses (SiteID, ResponseCode, VisitDate, VisitStartedAt, Rating, Priority, Status, MeasuredPh, SampleDepth, IsVerified, Comments, LongNarrative, RichTextNotes) VALUES ($siteId, $(Esc $r.Code), $(DateLit $visitDate), $(DateLit $started), $($r.Rating), $($r.Priority), $(Esc $r.Status), $($r.Ph), $($r.Depth), $($r.Verified), $(Esc $r.Comments), $(Esc $longNarrative), $(Esc $r.Rich))"
}

# ---- Seed binary cells (RawPayload PDF + LegacyPhoto PNG) ----------
# Bytes are streamed in via ADO Recordset.AppendChunk because OLEDB SQL
# literals can't carry a byte[]. We seed two rows so the helper's binary
# upload pass has a JPEG/PDF/PNG sample to round-trip into Dataverse.
function UpdateBinaryCell($whereCol, $whereValSql, $targetCol, [byte[]]$bytes) {
    if (-not $bytes -or $bytes.Length -eq 0) { return }
    $rs = New-Object -ComObject ADODB.Recordset
    try {
        # adOpenKeyset = 1, adLockOptimistic = 3
        $rs.Open("SELECT * FROM SurveyResponses WHERE $whereCol = $whereValSql", $conn, 1, 3)
        if ($rs.EOF) {
            Write-Host "  Skip binary seed: no SurveyResponses row where $whereCol = $whereValSql" -ForegroundColor Yellow
            return
        }
        # AppendChunk accepts a COM SafeArray of bytes; PowerShell's byte[] marshals automatically.
        $rs.Fields.Item($targetCol).AppendChunk($bytes)
        $rs.Update()
        Write-Host "  Seeded $targetCol on $whereCol=$whereValSql ($($bytes.Length) bytes)" -ForegroundColor DarkGreen
    } catch {
        Write-Host "  Skipped binary seed for ${targetCol}: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        if ($rs.State -ne 0) { $rs.Close() }
    }
}

# Minimal valid 1x1 transparent PNG (67 bytes).
$pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
$pngBytes = [Convert]::FromBase64String($pngB64)

# Minimal valid PDF stub (~ 220 bytes, opens in Adobe Reader as a 0-page doc).
$pdfText = @"
%PDF-1.4
%âãÏÓ
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Count 0 /Kids [] >> endobj
xref
0 3
0000000000 65535 f
0000000015 00000 n
0000000063 00000 n
trailer << /Size 3 /Root 1 0 R >>
startxref
112
%%EOF
"@
$pdfBytes = [System.Text.Encoding]::Latin1.GetBytes($pdfText)

# Row 1 (R-SEA-001): PDF in RawPayload (Binary)
UpdateBinaryCell 'ResponseCode' "'R-SEA-001'" 'RawPayload' $pdfBytes
# Row 2 (R-DEN-001): PNG in LegacyPhoto (OLE Object) — only if the ALTER succeeded
if ($hasLegacyPhoto) {
    UpdateBinaryCell 'ResponseCode' "'R-DEN-001'" 'LegacyPhoto' $pngBytes
}
# Row 3 (R-MIA-001): PNG in RawPayload too so we exercise image detection in Binary column
UpdateBinaryCell 'ResponseCode' "'R-MIA-001'" 'RawPayload' $pngBytes

$conn.Close() | Out-Null
$conn = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

$size = (Get-Item $OutFile).Length
Write-Host ''
Write-Host "Created $OutFile ($([math]::Round($size / 1KB, 1)) KB)" -ForegroundColor Green
Write-Host '  Tables: SiteStatuses, GeoSites, SurveyResponses'
Write-Host '  Key checks: DOUBLE lat/long, DECIMAL precision, MEMO long/multiline text, Lookup Wizard metadata, unsupported Binary, optional MVL/Attachment'
if (-not $hasDecimal) { Write-Host '  Note: AccuracyMeters DECIMAL column was not created by this ACE provider.' -ForegroundColor Yellow }
if (-not $hasLegacyPhoto) { Write-Host '  Note: LegacyPhoto binary column was not created by this ACE provider.' -ForegroundColor Yellow }
if (-not $hasTags) { Write-Host '  Note: Tags MULTIVALUE column was not created by this ACE provider.' -ForegroundColor Yellow }
if (-not $hasAttachment) { Write-Host '  Note: EvidenceFiles ATTACHMENT column was not created by this ACE provider.' -ForegroundColor Yellow }
Write-Host ''
Write-Host 'Test it in the wizard: select this file in step 1 (Connect).' -ForegroundColor Cyan
