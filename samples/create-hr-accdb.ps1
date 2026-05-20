# Creates a medium-complexity HR-style Access database for load-testing
# the Access-To-Power migration wizard. Adds patterns the Northwind sample
# does not exercise:
#   - Self-referential FK            (Employees.ManagerID -> Employees)
#   - N:N junction with extra cols   (ProjectAssignments)
#   - Multi-level relationship chain (Employees -> TimeEntries -> Project)
#   - SINGLE float                   (HoursAllocated)
#   - DATETIME with both date+time   (TimeEntries.EntryDate)
#   - Required-vs-optional mix
#
# Requires Access Database Engine 2016 (x64).
#
# Usage:
#   .\create-hr-accdb.ps1                          # writes .\samples\hr-mid.accdb
#   .\create-hr-accdb.ps1 -Force                   # overwrite existing
#
# Tables (singular & plural mix on purpose so the wizard's singularizer
# gets exercised):
#   Departments, Positions, Employees, Projects,
#   ProjectAssignments, TimeEntries

[CmdletBinding()]
param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'hr-mid.accdb'),
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
function Exec($sql) { $conn.Execute($sql) | Out-Null }
function Esc($s) { if ($null -eq $s) { 'NULL' } else { "'" + ($s -replace "'", "''") + "'" } }

# ---- DDL --------------------------------------------------------------
Exec @"
CREATE TABLE Departments (
    DepartmentID    AUTOINCREMENT PRIMARY KEY,
    DepartmentName  TEXT(60) NOT NULL,
    Location        TEXT(60),
    AnnualBudget    CURRENCY
)
"@

Exec @"
CREATE TABLE Positions (
    PositionID      AUTOINCREMENT PRIMARY KEY,
    Title           TEXT(80) NOT NULL,
    DepartmentID    LONG NOT NULL,
    MinSalary       CURRENCY,
    MaxSalary       CURRENCY,
    IsManagerRole   BIT NOT NULL,
    CONSTRAINT fk_pos_dept FOREIGN KEY (DepartmentID) REFERENCES Departments(DepartmentID)
)
"@

# Employees -- self-FK ManagerID. Created with FK constraint AFTER the
# table exists (ALTER TABLE) so we can reference the same table.
Exec @"
CREATE TABLE Employees (
    EmployeeID      AUTOINCREMENT PRIMARY KEY,
    FirstName       TEXT(40) NOT NULL,
    LastName        TEXT(40) NOT NULL,
    Email           TEXT(120) NOT NULL,
    PhoneNumber     TEXT(30),
    HireDate        DATETIME NOT NULL,
    BirthDate       DATETIME,
    PositionID      LONG NOT NULL,
    ManagerID       LONG,
    Salary          CURRENCY,
    IsActive        BIT NOT NULL,
    Notes           MEMO,
    CONSTRAINT fk_emp_pos FOREIGN KEY (PositionID) REFERENCES Positions(PositionID)
)
"@
Exec "ALTER TABLE Employees ADD CONSTRAINT fk_emp_mgr FOREIGN KEY (ManagerID) REFERENCES Employees(EmployeeID)"

Exec @"
CREATE TABLE Projects (
    ProjectID       AUTOINCREMENT PRIMARY KEY,
    ProjectCode     TEXT(20) NOT NULL,
    ProjectName     TEXT(120) NOT NULL,
    StartDate       DATETIME NOT NULL,
    EndDate         DATETIME,
    Budget          CURRENCY,
    ProjectStatus   TEXT(20) NOT NULL,
    Description     MEMO
)
"@

# N:N junction WITH extra columns (Role, HoursAllocated).
Exec @"
CREATE TABLE ProjectAssignments (
    AssignmentID    AUTOINCREMENT PRIMARY KEY,
    ProjectID       LONG NOT NULL,
    EmployeeID      LONG NOT NULL,
    AssignedRole    TEXT(60) NOT NULL,
    HoursAllocated  SINGLE,
    AssignedOn      DATETIME NOT NULL,
    CONSTRAINT fk_pa_proj FOREIGN KEY (ProjectID) REFERENCES Projects(ProjectID),
    CONSTRAINT fk_pa_emp  FOREIGN KEY (EmployeeID) REFERENCES Employees(EmployeeID)
)
"@

Exec @"
CREATE TABLE TimeEntries (
    EntryID         AUTOINCREMENT PRIMARY KEY,
    EmployeeID      LONG NOT NULL,
    ProjectID       LONG NOT NULL,
    EntryDate       DATETIME NOT NULL,
    HoursWorked     SINGLE NOT NULL,
    Billable        BIT NOT NULL,
    WorkDescription MEMO,
    CONSTRAINT fk_te_emp  FOREIGN KEY (EmployeeID) REFERENCES Employees(EmployeeID),
    CONSTRAINT fk_te_proj FOREIGN KEY (ProjectID) REFERENCES Projects(ProjectID)
)
"@

# ---- Seed -------------------------------------------------------------
function GetId($table, $col, $val) {
    $rs = $conn.Execute("SELECT * FROM $table WHERE $col = $(Esc $val)")
    if ($rs.EOF) { throw "Not found: $table.$col = $val" }
    $id = [int]$rs.Fields.Item(0).Value
    $rs.Close() | Out-Null
    return $id
}

$departments = @(
    @{ N = 'Engineering';    L = 'Seattle, WA';    B = 4500000 },
    @{ N = 'Sales';          L = 'Chicago, IL';    B = 2200000 },
    @{ N = 'Marketing';      L = 'New York, NY';   B = 1500000 },
    @{ N = 'Human Resources';L = 'Seattle, WA';    B =  600000 },
    @{ N = 'Finance';        L = 'Boston, MA';     B =  900000 }
)
foreach ($d in $departments) {
    Exec "INSERT INTO Departments (DepartmentName, Location, AnnualBudget) VALUES ($(Esc $d.N), $(Esc $d.L), $($d.B))"
}

$positions = @(
    @{ T = 'VP of Engineering';   D = 'Engineering';     Mn = 180000; Mx = 240000; Mgr = $true  },
    @{ T = 'Engineering Manager'; D = 'Engineering';     Mn = 140000; Mx = 180000; Mgr = $true  },
    @{ T = 'Senior Engineer';     D = 'Engineering';     Mn = 110000; Mx = 150000; Mgr = $false },
    @{ T = 'Software Engineer';   D = 'Engineering';     Mn =  80000; Mx = 115000; Mgr = $false },
    @{ T = 'QA Engineer';         D = 'Engineering';     Mn =  70000; Mx = 100000; Mgr = $false },
    @{ T = 'VP of Sales';         D = 'Sales';           Mn = 170000; Mx = 230000; Mgr = $true  },
    @{ T = 'Account Executive';   D = 'Sales';           Mn =  70000; Mx = 130000; Mgr = $false },
    @{ T = 'Sales Development';   D = 'Sales';           Mn =  55000; Mx =  80000; Mgr = $false },
    @{ T = 'Marketing Director';  D = 'Marketing';       Mn = 130000; Mx = 180000; Mgr = $true  },
    @{ T = 'Content Strategist';  D = 'Marketing';       Mn =  75000; Mx = 110000; Mgr = $false },
    @{ T = 'HR Director';         D = 'Human Resources'; Mn = 120000; Mx = 160000; Mgr = $true  },
    @{ T = 'HR Specialist';       D = 'Human Resources'; Mn =  60000; Mx =  85000; Mgr = $false },
    @{ T = 'CFO';                 D = 'Finance';         Mn = 200000; Mx = 280000; Mgr = $true  },
    @{ T = 'Accountant';          D = 'Finance';         Mn =  65000; Mx =  95000; Mgr = $false }
)
foreach ($p in $positions) {
    $did = GetId 'Departments' 'DepartmentName' $p.D
    $m   = if ($p.Mgr) { 1 } else { 0 }
    Exec "INSERT INTO Positions (Title, DepartmentID, MinSalary, MaxSalary, IsManagerRole) VALUES ($(Esc $p.T), $did, $($p.Mn), $($p.Mx), $m)"
}

# Employees -- managers first (NULL ManagerID), then their reports.
$rand = [System.Random]::new(101)
$firstNames = @('Olivia','Liam','Emma','Noah','Ava','Ethan','Sophia','Mason','Isabella','James','Mia','Lucas','Amelia','Henry','Harper','Alexander','Evelyn','Benjamin','Charlotte','Daniel','Abigail','Matthew','Elizabeth','David','Avery','Joseph','Sofia','Samuel','Ella','Andrew','Madison','Jackson','Scarlett','Sebastian','Grace','Carter','Chloe','Wyatt','Lily','Jayden')
$lastNames  = @('Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson')
$baseDate   = [DateTime]::new(2026, 5, 13)

function NewEmail($fn, $ln, $rand) {
    $tag = $rand.Next(10, 99)
    return "$($fn.ToLower()).$($ln.ToLower())$tag@example.com"
}
function NewPhone($rand) {
    return "({0:000}) {1:000}-{2:0000}" -f $rand.Next(200,999), $rand.Next(200,999), $rand.Next(0,9999)
}
function NewNote($rand) {
    $blurbs = @('Solid performer in last review cycle.','Currently leading the platform initiative.','On parental leave through Q3.','Just promoted from individual contributor track.','Mentoring two junior engineers.','Working remotely from Austin.','Top sales rep for FY25.','Returning from sabbatical next quarter.')
    return $blurbs[$rand.Next($blurbs.Count)]
}

$managerTitles = @('VP of Engineering','Engineering Manager','VP of Sales','Marketing Director','HR Director','CFO')
$managerIds = @{}
foreach ($t in $managerTitles) {
    $posId = GetId 'Positions' 'Title' $t
    $fn = $firstNames[$rand.Next($firstNames.Count)]
    $ln = $lastNames[$rand.Next($lastNames.Count)]
    $email = NewEmail $fn $ln $rand
    $phone = NewPhone $rand
    $hire  = $baseDate.AddDays(-1 * $rand.Next(800, 3500)).ToString('yyyy-MM-dd HH:mm:ss')
    $birth = $baseDate.AddYears(-1 * $rand.Next(35, 60)).ToString('yyyy-MM-dd')
    $salary = 150000 + $rand.Next(0, 80000)
    $notes  = NewNote $rand
    Exec "INSERT INTO Employees (FirstName, LastName, Email, PhoneNumber, HireDate, BirthDate, PositionID, ManagerID, Salary, IsActive, Notes) VALUES ($(Esc $fn), $(Esc $ln), $(Esc $email), $(Esc $phone), #$hire#, #$birth#, $posId, NULL, $salary, 1, $(Esc $notes))"
    $managerIds[$t] = GetId 'Employees' 'Email' $email
}

# Map non-manager titles to a chain-of-command manager title.
$reportsTo = @{
    'Senior Engineer'      = 'Engineering Manager'
    'Software Engineer'    = 'Engineering Manager'
    'QA Engineer'          = 'Engineering Manager'
    'Account Executive'    = 'VP of Sales'
    'Sales Development'    = 'VP of Sales'
    'Content Strategist'   = 'Marketing Director'
    'HR Specialist'        = 'HR Director'
    'Accountant'           = 'CFO'
}

# Mid-level: Engineering Manager reports to VP of Engineering
$mgrId = $managerIds['Engineering Manager']
$emEmail = $null
$rs = $conn.Execute("SELECT Email FROM Employees WHERE EmployeeID = $mgrId")
$emEmail = $rs.Fields.Item('Email').Value; $rs.Close() | Out-Null
$vpId = $managerIds['VP of Engineering']
Exec "UPDATE Employees SET ManagerID = $vpId WHERE EmployeeID = $mgrId"

# Now create the reports (34 more employees -> total ~40)
$nonManagerPositions = @{
    'Senior Engineer'    = 6
    'Software Engineer'  = 10
    'QA Engineer'        = 4
    'Account Executive'  = 5
    'Sales Development'  = 3
    'Content Strategist' = 2
    'HR Specialist'      = 2
    'Accountant'         = 2
}
foreach ($title in $nonManagerPositions.Keys) {
    $count = $nonManagerPositions[$title]
    $posId = GetId 'Positions' 'Title' $title
    $managerTitle = $reportsTo[$title]
    $mid = $managerIds[$managerTitle]
    for ($i = 0; $i -lt $count; $i++) {
        $fn = $firstNames[$rand.Next($firstNames.Count)]
        $ln = $lastNames[$rand.Next($lastNames.Count)]
        $email = NewEmail $fn $ln $rand
        $phone = NewPhone $rand
        $hire  = $baseDate.AddDays(-1 * $rand.Next(30, 2000)).ToString('yyyy-MM-dd HH:mm:ss')
        $birth = $baseDate.AddYears(-1 * $rand.Next(24, 55)).ToString('yyyy-MM-dd')
        $minS  = ($positions | Where-Object { $_.T -eq $title }).Mn
        $maxS  = ($positions | Where-Object { $_.T -eq $title }).Mx
        $salary = $minS + $rand.Next(0, ($maxS - $minS))
        $active = if ($rand.Next(0, 10) -lt 9) { 1 } else { 0 }
        $notes  = if ($rand.Next(0, 3) -eq 0) { 'NULL' } else { Esc(NewNote $rand) }
        Exec "INSERT INTO Employees (FirstName, LastName, Email, PhoneNumber, HireDate, BirthDate, PositionID, ManagerID, Salary, IsActive, Notes) VALUES ($(Esc $fn), $(Esc $ln), $(Esc $email), $(Esc $phone), #$hire#, #$birth#, $posId, $mid, $salary, $active, $notes)"
    }
}

# Projects
$projects = @(
    @{ C = 'PRJ-001'; N = 'Customer Portal Refresh';      S = '2025-09-01'; E = '2026-03-30'; B = 350000; St = 'Active'    },
    @{ C = 'PRJ-002'; N = 'Mobile App v2';                S = '2025-10-15'; E = $null;        B = 600000; St = 'Active'    },
    @{ C = 'PRJ-003'; N = 'Q1 Sales Campaign';            S = '2026-01-05'; E = '2026-03-31'; B = 180000; St = 'Completed' },
    @{ C = 'PRJ-004'; N = 'Compliance Audit FY26';        S = '2026-02-10'; E = '2026-06-30'; B =  90000; St = 'Active'    },
    @{ C = 'PRJ-005'; N = 'Brand Refresh';                S = '2026-03-01'; E = $null;        B = 220000; St = 'Active'    },
    @{ C = 'PRJ-006'; N = 'Internal Tools Modernization'; S = '2025-06-15'; E = '2026-04-30'; B = 410000; St = 'OnHold'    },
    @{ C = 'PRJ-007'; N = 'Recruiting Pipeline Revamp';   S = '2026-04-01'; E = $null;        B =  75000; St = 'Active'    },
    @{ C = 'PRJ-008'; N = 'Data Warehouse Migration';     S = '2025-11-20'; E = '2026-05-31'; B = 520000; St = 'Active'    },
    @{ C = 'PRJ-009'; N = 'Customer Feedback Loop';       S = '2026-03-15'; E = $null;        B =  60000; St = 'Active'    },
    @{ C = 'PRJ-010'; N = 'Sunset Legacy CRM';            S = '2025-12-01'; E = '2026-04-15'; B = 140000; St = 'Completed' }
)
foreach ($p in $projects) {
    $end = if ($p.E) { "#$($p.E)#" } else { 'NULL' }
    $desc = "Project $($p.C): see Confluence for details."
    Exec "INSERT INTO Projects (ProjectCode, ProjectName, StartDate, EndDate, Budget, ProjectStatus, Description) VALUES ($(Esc $p.C), $(Esc $p.N), #$($p.S)#, $end, $($p.B), $(Esc $p.St), $(Esc $desc))"
}

# Project assignments -- pick 5-10 random employees per project
$empIds = @()
$rs = $conn.Execute('SELECT EmployeeID FROM Employees')
while (-not $rs.EOF) { $empIds += [int]$rs.Fields.Item(0).Value; $rs.MoveNext() | Out-Null }
$rs.Close() | Out-Null

$projIds = @()
$rs = $conn.Execute('SELECT ProjectID FROM Projects')
while (-not $rs.EOF) { $projIds += [int]$rs.Fields.Item(0).Value; $rs.MoveNext() | Out-Null }
$rs.Close() | Out-Null

$roles = @('Project Lead','Engineer','Designer','Analyst','Reviewer','QA','PM','Stakeholder')
$assignmentCount = 0
foreach ($prjId in $projIds) {
    $teamSize = $rand.Next(5, 11)
    $picked = $empIds | Get-Random -Count $teamSize
    foreach ($eid in $picked) {
        $role = $roles[$rand.Next($roles.Count)]
        $hours = [math]::Round(($rand.NextDouble() * 30 + 10), 2)
        $assigned = $baseDate.AddDays(-1 * $rand.Next(0, 200)).ToString('yyyy-MM-dd')
        Exec "INSERT INTO ProjectAssignments (ProjectID, EmployeeID, AssignedRole, HoursAllocated, AssignedOn) VALUES ($prjId, $eid, $(Esc $role), $hours, #$assigned#)"
        $assignmentCount++
    }
}

# Time entries -- ~6 per assignment, spread over recent weeks
$timeCount = 0
$rs = $conn.Execute('SELECT EmployeeID, ProjectID FROM ProjectAssignments')
$pairs = @()
while (-not $rs.EOF) {
    $pairs += [pscustomobject]@{ Emp = [int]$rs.Fields.Item('EmployeeID').Value; Proj = [int]$rs.Fields.Item('ProjectID').Value }
    $rs.MoveNext() | Out-Null
}
$rs.Close() | Out-Null

$workDescs = @('Standup + design review','Wrote unit tests for payment flow','Fixed regression in nightly build','Pair programming with Casey','Customer call follow-up','Sprint planning','Drafted Q3 roadmap','Code review backlog','Refactored notification service','Hot-fix for prod incident')

foreach ($pair in $pairs) {
    $entries = $rand.Next(3, 8)
    for ($i = 0; $i -lt $entries; $i++) {
        $day = $baseDate.AddDays(-1 * $rand.Next(0, 60))
        $entryDate = $day.AddHours($rand.Next(8, 18)).AddMinutes($rand.Next(0,59)).ToString('yyyy-MM-dd HH:mm:ss')
        $hours = [math]::Round(($rand.NextDouble() * 7 + 0.5), 2)
        $billable = if ($rand.Next(0,10) -lt 8) { 1 } else { 0 }
        $desc = $workDescs[$rand.Next($workDescs.Count)]
        Exec "INSERT INTO TimeEntries (EmployeeID, ProjectID, EntryDate, HoursWorked, Billable, WorkDescription) VALUES ($($pair.Emp), $($pair.Proj), #$entryDate#, $hours, $billable, $(Esc $desc))"
        $timeCount++
    }
}

$conn.Close() | Out-Null
$conn = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

$size = (Get-Item $OutFile).Length
$empCount = ($managerIds.Count) + ($nonManagerPositions.Values | Measure-Object -Sum).Sum
Write-Host ""
Write-Host "OK Created $OutFile ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
Write-Host "  Departments:        $($departments.Count)"
Write-Host "  Positions:          $($positions.Count)"
Write-Host "  Employees:          $empCount  (incl. self-ref ManagerID chain)"
Write-Host "  Projects:           $($projects.Count)"
Write-Host "  ProjectAssignments: $assignmentCount"
Write-Host "  TimeEntries:        $timeCount"
