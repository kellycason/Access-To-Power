# Creates a small Northwind-style Access database for testing the
# Access-To-Power migration wizard. Uses ADOX (catalog) to create the .accdb
# and ADO to insert sample rows. Requires Access Database Engine 2016 (x64).
#
# Usage:
#   .\create-sample-accdb.ps1                       # writes .\samples\northwind-lite.accdb
#   .\create-sample-accdb.ps1 -OutFile C:\tmp\x.accdb -Force
#
# Tables created:
#   Categories(CategoryID PK, CategoryName, Description)
#   Suppliers (SupplierID PK, CompanyName, ContactName, City, Country)
#   Products  (ProductID PK, ProductName, CategoryID FK, SupplierID FK,
#              UnitPrice, UnitsInStock, Discontinued)
#   Orders    (OrderID PK, OrderDate, CustomerName, ProductID FK, Quantity, Total)

[CmdletBinding()]
param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'northwind-lite.accdb'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (Test-Path $OutFile) {
    if ($Force) { Remove-Item $OutFile -Force }
    else { throw "File exists: $OutFile. Re-run with -Force to overwrite." }
}

$dir = Split-Path $OutFile -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

# Provider: ACE 16.0 (Access 2016+). Database type: ACCDB.
$connStr = "Provider=Microsoft.ACE.OLEDB.16.0;Data Source=$OutFile;Jet OLEDB:Engine Type=6;"

Write-Host "Creating $OutFile…" -ForegroundColor Cyan

# --- Create the database file via ADOX -----------------------------------
$cat = New-Object -ComObject ADOX.Catalog
$cat.Create($connStr) | Out-Null
$cat = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

# --- Open a single ADO connection for DDL + DML --------------------------
$conn = New-Object -ComObject ADODB.Connection
$conn.Open($connStr)

function Exec($sql) {
    Write-Verbose "SQL: $sql"
    $conn.Execute($sql) | Out-Null
}

# --- DDL ------------------------------------------------------------------
Exec @"
CREATE TABLE Categories (
    CategoryID    AUTOINCREMENT PRIMARY KEY,
    CategoryName  TEXT(50) NOT NULL,
    Description   MEMO
)
"@

Exec @"
CREATE TABLE Suppliers (
    SupplierID    AUTOINCREMENT PRIMARY KEY,
    CompanyName   TEXT(80) NOT NULL,
    ContactName   TEXT(60),
    City          TEXT(40),
    Country       TEXT(40)
)
"@

Exec @"
CREATE TABLE Products (
    ProductID     AUTOINCREMENT PRIMARY KEY,
    ProductName   TEXT(80) NOT NULL,
    CategoryID    LONG,
    SupplierID    LONG,
    UnitPrice     CURRENCY,
    UnitsInStock  INTEGER,
    Discontinued  BIT NOT NULL,
    CONSTRAINT fk_products_category FOREIGN KEY (CategoryID) REFERENCES Categories(CategoryID),
    CONSTRAINT fk_products_supplier FOREIGN KEY (SupplierID) REFERENCES Suppliers(SupplierID)
)
"@

Exec @"
CREATE TABLE Orders (
    OrderID       AUTOINCREMENT PRIMARY KEY,
    OrderDate     DATETIME NOT NULL,
    CustomerName  TEXT(80) NOT NULL,
    ProductID     LONG NOT NULL,
    Quantity      INTEGER NOT NULL,
    Total         CURRENCY,
    CONSTRAINT fk_orders_product FOREIGN KEY (ProductID) REFERENCES Products(ProductID)
)
"@

# --- Seed data ------------------------------------------------------------
function Esc($s) { if ($null -eq $s) { 'NULL' } else { "'" + ($s -replace "'", "''") + "'" } }

# Categories
$cats = @(
    @{ N = 'Beverages';      D = 'Soft drinks, coffees, teas, beers, and ales' },
    @{ N = 'Condiments';     D = 'Sweet and savory sauces, relishes, spreads, and seasonings' },
    @{ N = 'Confections';    D = 'Desserts, candies, and sweet breads' },
    @{ N = 'Dairy Products'; D = 'Cheeses' },
    @{ N = 'Grains/Cereals'; D = 'Breads, crackers, pasta, and cereal' },
    @{ N = 'Produce';        D = 'Dried fruit and bean curd' },
    @{ N = 'Seafood';        D = 'Seaweed and fish' }
)
foreach ($c in $cats) {
    Exec "INSERT INTO Categories (CategoryName, Description) VALUES ($(Esc $c.N), $(Esc $c.D))"
}

# Suppliers
$sups = @(
    @{ C = 'Exotic Liquids';            N = 'Charlotte Cooper'; Ci = 'London';     Co = 'UK' },
    @{ C = 'New Orleans Cajun Delights'; N = 'Shelley Burke';   Ci = 'New Orleans'; Co = 'USA' },
    @{ C = 'Grandma Kelly''s Homestead'; N = 'Regina Murphy';   Ci = 'Ann Arbor';   Co = 'USA' },
    @{ C = 'Tokyo Traders';             N = 'Yoshi Nagase';    Ci = 'Tokyo';       Co = 'Japan' },
    @{ C = 'Cooperativa de Quesos';     N = 'Antonio del Valle'; Ci = 'Oviedo';   Co = 'Spain' },
    @{ C = 'Mayumi''s';                  N = 'Mayumi Ohno';     Ci = 'Osaka';      Co = 'Japan' },
    @{ C = 'Pavlova, Ltd.';              N = 'Ian Devling';    Ci = 'Melbourne';   Co = 'Australia' },
    @{ C = 'Specialty Biscuits, Ltd.';   N = 'Peter Wilson';    Ci = 'Manchester';  Co = 'UK' }
)
foreach ($s in $sups) {
    Exec "INSERT INTO Suppliers (CompanyName, ContactName, City, Country) VALUES ($(Esc $s.C), $(Esc $s.N), $(Esc $s.Ci), $(Esc $s.Co))"
}

# Products (CategoryID/SupplierID are autoincrement so we look them up)
$prods = @(
    @{ N = 'Chai';                C = 'Beverages';      S = 'Exotic Liquids';            P = 18.00; St = 39; D = $false },
    @{ N = 'Chang';               C = 'Beverages';      S = 'Exotic Liquids';            P = 19.00; St = 17; D = $false },
    @{ N = 'Aniseed Syrup';       C = 'Condiments';     S = 'Exotic Liquids';            P = 10.00; St = 13; D = $false },
    @{ N = 'Chef Antons Cajun';   C = 'Condiments';     S = 'New Orleans Cajun Delights'; P = 22.00; St = 53; D = $false },
    @{ N = 'Chef Antons Gumbo';   C = 'Condiments';     S = 'New Orleans Cajun Delights'; P = 21.35; St = 0;  D = $true  },
    @{ N = 'Grandmas Boysenberry'; C = 'Condiments';    S = 'Grandma Kelly''s Homestead'; P = 25.00; St = 120; D = $false },
    @{ N = 'Uncle Bobs Pears';    C = 'Produce';        S = 'Grandma Kelly''s Homestead'; P = 30.00; St = 15; D = $false },
    @{ N = 'Northwoods Sauce';    C = 'Condiments';     S = 'Grandma Kelly''s Homestead'; P = 40.00; St = 6;  D = $false },
    @{ N = 'Mishi Kobe Niku';     C = 'Seafood';        S = 'Tokyo Traders';             P = 97.00; St = 29; D = $true  },
    @{ N = 'Ikura';               C = 'Seafood';        S = 'Tokyo Traders';             P = 31.00; St = 31; D = $false },
    @{ N = 'Queso Cabrales';      C = 'Dairy Products'; S = 'Cooperativa de Quesos';     P = 21.00; St = 22; D = $false },
    @{ N = 'Queso Manchego';      C = 'Dairy Products'; S = 'Cooperativa de Quesos';     P = 38.00; St = 86; D = $false },
    @{ N = 'Konbu';               C = 'Seafood';        S = 'Mayumi''s';                  P = 6.00;  St = 24; D = $false },
    @{ N = 'Tofu';                C = 'Produce';        S = 'Mayumi''s';                  P = 23.25; St = 35; D = $false },
    @{ N = 'Pavlova';             C = 'Confections';    S = 'Pavlova, Ltd.';             P = 17.45; St = 29; D = $false },
    @{ N = 'Alice Mutton';        C = 'Seafood';        S = 'Pavlova, Ltd.';             P = 39.00; St = 0;  D = $true  },
    @{ N = 'Carnarvon Tigers';    C = 'Seafood';        S = 'Pavlova, Ltd.';             P = 62.50; St = 42; D = $false },
    @{ N = 'Teatime Chocolate';   C = 'Confections';    S = 'Specialty Biscuits, Ltd.';  P = 9.20;  St = 25; D = $false },
    @{ N = 'Sir Rodneys Marmalade'; C = 'Confections';  S = 'Specialty Biscuits, Ltd.';  P = 81.00; St = 40; D = $false },
    @{ N = 'Sir Rodneys Scones';  C = 'Confections';    S = 'Specialty Biscuits, Ltd.';  P = 10.00; St = 3;  D = $false }
)

# Build name->id lookups for FK resolution
function GetId($table, $col, $val) {
    $sql = "SELECT * FROM $table WHERE $col = $(Esc $val)"
    $rs = $conn.Execute($sql)
    if ($rs.EOF) { throw "Not found: $table.$col = $val" }
    $id = $rs.Fields.Item(0).Value
    $rs.Close() | Out-Null
    return [int]$id
}

foreach ($p in $prods) {
    $catId = GetId 'Categories' 'CategoryName' $p.C
    $supId = GetId 'Suppliers'  'CompanyName'  $p.S
    $disc  = if ($p.D) { 1 } else { 0 }
    Exec "INSERT INTO Products (ProductName, CategoryID, SupplierID, UnitPrice, UnitsInStock, Discontinued) VALUES ($(Esc $p.N), $catId, $supId, $($p.P), $($p.St), $disc)"
}

# Orders — generate 150 random orders across the products
$customers = @('Alfreds Futterkiste','Around the Horn','Berglunds snabbköp','Blauer See Delikatessen','Bólido Comidas preparadas','Cactus Comidas para llevar','Chop-suey Chinese','Du monde entier','Eastern Connection','Familia Arquibaldo','GROSELLA-Restaurante','Hanari Carnes','Island Trading','Königlich Essen','La maison d''Asie','Magazzini Alimentari Riuniti','North/South','Océano Atlántico','Princesa Isabel Vinhos','Que Delícia')

$prodRs = $conn.Execute('SELECT ProductID, UnitPrice FROM Products')
$prodList = @()
while (-not $prodRs.EOF) {
    $prodList += [pscustomobject]@{
        Id = [int]$prodRs.Fields.Item('ProductID').Value
        Price = [decimal]$prodRs.Fields.Item('UnitPrice').Value
    }
    $prodRs.MoveNext() | Out-Null
}
$prodRs.Close() | Out-Null

$rand = [System.Random]::new(42)
$today = [DateTime]::new(2026, 5, 13)
for ($i = 0; $i -lt 150; $i++) {
    $p = $prodList[$rand.Next($prodList.Count)]
    $qty = $rand.Next(1, 30)
    $cust = $customers[$rand.Next($customers.Count)]
    $date = $today.AddDays(-1 * $rand.Next(0, 365)).ToString('yyyy-MM-dd HH:mm:ss')
    $total = [math]::Round($p.Price * $qty, 2)
    Exec "INSERT INTO Orders (OrderDate, CustomerName, ProductID, Quantity, Total) VALUES (#$date#, $(Esc $cust), $($p.Id), $qty, $total)"
}

$conn.Close() | Out-Null
$conn = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

$size = (Get-Item $OutFile).Length
Write-Host ""
Write-Host "✓ Created $OutFile ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
Write-Host "  Categories: $($cats.Count) rows"
Write-Host "  Suppliers:  $($sups.Count) rows"
Write-Host "  Products:   $($prods.Count) rows"
Write-Host "  Orders:     150 rows"
Write-Host ""
Write-Host "Test it in the wizard: select this file in step 1 (Connect)." -ForegroundColor Cyan
