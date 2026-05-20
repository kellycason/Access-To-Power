# Creates a higher-complexity library Access database for load-testing
# the Access-To-Power migration wizard. Patterns this exercises:
#   - 10 tables (multi-screen mapping flow)
#   - Multi-level relationship chain (Loans -> LoanEvents)
#   - Two self-referential FKs (BookCategories.ParentCategoryID, Patrons.ReferredByPatronID)
#   - N:N junction WITH extras   (BookAuthors w/ AuthorOrder)
#   - N:N junction WITHOUT extras (BookCategoryAssignments)
#   - 1:N child table             (PatronAddresses)
#   - BYTE small-int, SINGLE,     larger MEMO blobs
#   - A column literally named "Status" (Dataverse-reserved-ish)
#   - Larger row counts (~400 loan events) to stress batching
#
# Requires Access Database Engine 2016 (x64).
#
# Usage:
#   .\create-library-accdb.ps1               # writes .\samples\library-complex.accdb
#   .\create-library-accdb.ps1 -Force        # overwrite existing

[CmdletBinding()]
param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'library-complex.accdb'),
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
CREATE TABLE Patrons (
    PatronID            AUTOINCREMENT PRIMARY KEY,
    MembershipNumber    TEXT(20) NOT NULL,
    FirstName           TEXT(40) NOT NULL,
    LastName            TEXT(40) NOT NULL,
    Email               TEXT(120),
    Phone               TEXT(30),
    JoinDate            DATETIME NOT NULL,
    BirthYear           INTEGER,
    IsActive            BIT NOT NULL,
    ReferredByPatronID  LONG,
    Notes               MEMO
)
"@
Exec "ALTER TABLE Patrons ADD CONSTRAINT fk_patron_ref FOREIGN KEY (ReferredByPatronID) REFERENCES Patrons(PatronID)"

Exec @"
CREATE TABLE PatronAddresses (
    AddressID           AUTOINCREMENT PRIMARY KEY,
    PatronID            LONG NOT NULL,
    AddressType         TEXT(20) NOT NULL,
    StreetLine1         TEXT(120) NOT NULL,
    StreetLine2         TEXT(120),
    City                TEXT(60) NOT NULL,
    StateOrProvince     TEXT(40),
    PostalCode          TEXT(20),
    Country             TEXT(40),
    IsPrimary           BIT NOT NULL,
    CONSTRAINT fk_addr_patron FOREIGN KEY (PatronID) REFERENCES Patrons(PatronID)
)
"@

Exec @"
CREATE TABLE Authors (
    AuthorID            AUTOINCREMENT PRIMARY KEY,
    FirstName           TEXT(40) NOT NULL,
    LastName            TEXT(60) NOT NULL,
    BirthYear           INTEGER,
    Nationality         TEXT(40),
    Biography           MEMO,
    WebsiteUrl          TEXT(255)
)
"@

Exec @"
CREATE TABLE Publishers (
    PublisherID         AUTOINCREMENT PRIMARY KEY,
    PublisherName       TEXT(120) NOT NULL,
    Country             TEXT(40),
    FoundedYear         INTEGER,
    Website             TEXT(255)
)
"@

Exec @"
CREATE TABLE BookCategories (
    CategoryID          AUTOINCREMENT PRIMARY KEY,
    CategoryName        TEXT(80) NOT NULL,
    ParentCategoryID    LONG,
    SortOrder           BYTE
)
"@
Exec "ALTER TABLE BookCategories ADD CONSTRAINT fk_cat_parent FOREIGN KEY (ParentCategoryID) REFERENCES BookCategories(CategoryID)"

Exec @"
CREATE TABLE Books (
    BookID              AUTOINCREMENT PRIMARY KEY,
    ISBN                TEXT(20),
    Title               TEXT(200) NOT NULL,
    Subtitle            TEXT(200),
    PublisherID         LONG,
    PublishedDate       DATETIME,
    Pages               INTEGER,
    [Language]          TEXT(20),
    AvailableCopies     INTEGER NOT NULL,
    TotalCopies         INTEGER NOT NULL,
    RetailPrice         CURRENCY,
    Description         MEMO,
    CONSTRAINT fk_book_pub FOREIGN KEY (PublisherID) REFERENCES Publishers(PublisherID)
)
"@

# N:N with extra column (AuthorOrder)
Exec @"
CREATE TABLE BookAuthors (
    BookAuthorID        AUTOINCREMENT PRIMARY KEY,
    BookID              LONG NOT NULL,
    AuthorID            LONG NOT NULL,
    AuthorOrder         BYTE NOT NULL,
    CONSTRAINT fk_ba_book   FOREIGN KEY (BookID)   REFERENCES Books(BookID),
    CONSTRAINT fk_ba_author FOREIGN KEY (AuthorID) REFERENCES Authors(AuthorID)
)
"@

# Pure N:N junction (no extras)
Exec @"
CREATE TABLE BookCategoryAssignments (
    BookCategoryAssignmentID AUTOINCREMENT PRIMARY KEY,
    BookID                   LONG NOT NULL,
    CategoryID               LONG NOT NULL,
    CONSTRAINT fk_bca_book FOREIGN KEY (BookID)     REFERENCES Books(BookID),
    CONSTRAINT fk_bca_cat  FOREIGN KEY (CategoryID) REFERENCES BookCategories(CategoryID)
)
"@

Exec @"
CREATE TABLE Loans (
    LoanID              AUTOINCREMENT PRIMARY KEY,
    PatronID            LONG NOT NULL,
    BookID              LONG NOT NULL,
    LoanDate            DATETIME NOT NULL,
    DueDate             DATETIME NOT NULL,
    ReturnDate          DATETIME,
    RenewalCount        BYTE NOT NULL,
    FineAmount          CURRENCY,
    [Status]            TEXT(20) NOT NULL,
    CONSTRAINT fk_loan_patron FOREIGN KEY (PatronID) REFERENCES Patrons(PatronID),
    CONSTRAINT fk_loan_book   FOREIGN KEY (BookID)   REFERENCES Books(BookID)
)
"@

Exec @"
CREATE TABLE LoanEvents (
    EventID             AUTOINCREMENT PRIMARY KEY,
    LoanID              LONG NOT NULL,
    EventDate           DATETIME NOT NULL,
    EventType           TEXT(30) NOT NULL,
    Notes               MEMO,
    CONSTRAINT fk_evt_loan FOREIGN KEY (LoanID) REFERENCES Loans(LoanID)
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

$rand = [System.Random]::new(2026)
$baseDate = [DateTime]::new(2026, 5, 13)

# Publishers
$pubs = @(
    @{ N = 'Penguin Random House';  C = 'USA';     F = 2013; W = 'https://penguinrandomhouse.com' },
    @{ N = 'HarperCollins';         C = 'USA';     F = 1989; W = 'https://harpercollins.com' },
    @{ N = 'Hachette Book Group';   C = 'France';  F = 2006; W = 'https://hachettebookgroup.com' },
    @{ N = 'Simon & Schuster';      C = 'USA';     F = 1924; W = 'https://simonandschuster.com' },
    @{ N = 'Macmillan Publishers';  C = 'UK';      F = 1843; W = 'https://macmillan.com' },
    @{ N = 'OReilly Media';         C = 'USA';     F = 1978; W = 'https://oreilly.com' },
    @{ N = 'Manning Publications';  C = 'USA';     F = 1990; W = 'https://manning.com' },
    @{ N = 'No Starch Press';       C = 'USA';     F = 1994; W = 'https://nostarch.com' }
)
foreach ($p in $pubs) {
    Exec "INSERT INTO Publishers (PublisherName, Country, FoundedYear, Website) VALUES ($(Esc $p.N), $(Esc $p.C), $($p.F), $(Esc $p.W))"
}

# Authors
$authors = @(
    @{ F='Jane';      L='Austen';        Y=1775; Nat='British';   B='English novelist known for Pride and Prejudice.' },
    @{ F='George';    L='Orwell';        Y=1903; Nat='British';   B='Author of 1984 and Animal Farm.' },
    @{ F='Toni';      L='Morrison';      Y=1931; Nat='American';  B='Nobel Prize-winning author of Beloved.' },
    @{ F='Haruki';    L='Murakami';      Y=1949; Nat='Japanese';  B='Contemporary Japanese novelist.' },
    @{ F='Chimamanda';L='Adichie';       Y=1977; Nat='Nigerian';  B='Author of Americanah and Half of a Yellow Sun.' },
    @{ F='Ursula';    L='Le Guin';       Y=1929; Nat='American';  B='Pioneering science fiction and fantasy author.' },
    @{ F='Gabriel';   L='Garcia Marquez';Y=1927; Nat='Colombian'; B='Magical realism master and Nobel laureate.' },
    @{ F='Margaret';  L='Atwood';        Y=1939; Nat='Canadian';  B='Author of The Handmaids Tale.' },
    @{ F='Robert';    L='Martin';        Y=1952; Nat='American';  B='Software engineer, author of Clean Code.' },
    @{ F='Martin';    L='Fowler';        Y=1963; Nat='British';   B='Author of Refactoring and Patterns of Enterprise Application Architecture.' },
    @{ F='Donald';    L='Knuth';         Y=1938; Nat='American';  B='Computer scientist, author of The Art of Computer Programming.' },
    @{ F='Eric';      L='Evans';         Y=1962; Nat='American';  B='Author of Domain-Driven Design.' },
    @{ F='Brian';     L='Kernighan';     Y=1942; Nat='Canadian';  B='Co-author of The C Programming Language.' },
    @{ F='Dennis';    L='Ritchie';       Y=1941; Nat='American';  B='Co-creator of C and Unix.' },
    @{ F='James';     L='Baldwin';       Y=1924; Nat='American';  B='Essayist and novelist.' },
    @{ F='Zora';      L='Hurston';       Y=1891; Nat='American';  B='Author of Their Eyes Were Watching God.' },
    @{ F='Italo';     L='Calvino';       Y=1923; Nat='Italian';   B='Postmodern novelist.' },
    @{ F='Kazuo';     L='Ishiguro';      Y=1954; Nat='British';   B='Nobel laureate, author of Remains of the Day.' },
    @{ F='Octavia';   L='Butler';        Y=1947; Nat='American';  B='Science fiction author of Kindred.' },
    @{ F='Neil';      L='Gaiman';        Y=1960; Nat='British';   B='Author of American Gods and Sandman.' }
)
foreach ($a in $authors) {
    $url = "https://example.com/authors/$($a.L.ToLower().Replace(' ',''))"
    Exec "INSERT INTO Authors (FirstName, LastName, BirthYear, Nationality, Biography, WebsiteUrl) VALUES ($(Esc $a.F), $(Esc $a.L), $($a.Y), $(Esc $a.Nat), $(Esc $a.B), $(Esc $url))"
}

# Categories with hierarchy: 4 roots + ~10 children
$rootCats = @('Fiction','Nonfiction','Technology','Childrens')
foreach ($i in 0..($rootCats.Count - 1)) {
    Exec "INSERT INTO BookCategories (CategoryName, ParentCategoryID, SortOrder) VALUES ($(Esc $rootCats[$i]), NULL, $($i + 1))"
}
$childCats = @(
    @{ N='Literary Fiction'; P='Fiction';    O=1 },
    @{ N='Science Fiction';  P='Fiction';    O=2 },
    @{ N='Fantasy';          P='Fiction';    O=3 },
    @{ N='Mystery';          P='Fiction';    O=4 },
    @{ N='Biography';        P='Nonfiction'; O=1 },
    @{ N='History';          P='Nonfiction'; O=2 },
    @{ N='Essays';           P='Nonfiction'; O=3 },
    @{ N='Programming';      P='Technology'; O=1 },
    @{ N='Software Design';  P='Technology'; O=2 },
    @{ N='Picture Books';    P='Childrens';  O=1 },
    @{ N='Middle Grade';     P='Childrens';  O=2 }
)
foreach ($c in $childCats) {
    $parentId = GetId 'BookCategories' 'CategoryName' $c.P
    Exec "INSERT INTO BookCategories (CategoryName, ParentCategoryID, SortOrder) VALUES ($(Esc $c.N), $parentId, $($c.O))"
}

# Books
$books = @(
    @{ T='Pride and Prejudice';      Sub=$null;                              Pub='Penguin Random House';  Date='1813-01-28'; Pages=432; Lang='English'; Price=12.99; Auth=@('Jane Austen');                Cats=@('Literary Fiction')                  },
    @{ T='1984';                     Sub='A Novel';                          Pub='HarperCollins';         Date='1949-06-08'; Pages=328; Lang='English'; Price=14.50; Auth=@('George Orwell');             Cats=@('Science Fiction','Literary Fiction')},
    @{ T='Beloved';                  Sub=$null;                              Pub='Penguin Random House';  Date='1987-09-02'; Pages=324; Lang='English'; Price=16.00; Auth=@('Toni Morrison');             Cats=@('Literary Fiction')                  },
    @{ T='Kafka on the Shore';       Sub=$null;                              Pub='Hachette Book Group';   Date='2002-09-12'; Pages=505; Lang='English'; Price=17.00; Auth=@('Haruki Murakami');           Cats=@('Literary Fiction','Fantasy')        },
    @{ T='Americanah';               Sub=$null;                              Pub='Simon & Schuster';      Date='2013-05-14'; Pages=477; Lang='English'; Price=16.95; Auth=@('Chimamanda Adichie');        Cats=@('Literary Fiction')                  },
    @{ T='The Left Hand of Darkness';Sub=$null;                              Pub='Penguin Random House';  Date='1969-03-01'; Pages=304; Lang='English'; Price=15.99; Auth=@('Ursula Le Guin');            Cats=@('Science Fiction')                   },
    @{ T='One Hundred Years of Solitude'; Sub=$null;                         Pub='Hachette Book Group';   Date='1967-05-30'; Pages=417; Lang='English'; Price=18.00; Auth=@('Gabriel Garcia Marquez');    Cats=@('Literary Fiction')                  },
    @{ T='The Handmaids Tale';       Sub=$null;                              Pub='Macmillan Publishers';  Date='1985-08-17'; Pages=311; Lang='English'; Price=15.50; Auth=@('Margaret Atwood');           Cats=@('Science Fiction','Literary Fiction')},
    @{ T='Clean Code';               Sub='A Handbook of Agile Software Craftsmanship'; Pub='OReilly Media';Date='2008-08-01';Pages=464; Lang='English'; Price=44.99; Auth=@('Robert Martin');             Cats=@('Programming','Software Design')     },
    @{ T='Refactoring';              Sub='Improving the Design of Existing Code';      Pub='Manning Publications';Date='1999-07-08';Pages=431;Lang='English';Price=54.99;Auth=@('Martin Fowler');         Cats=@('Programming','Software Design')     },
    @{ T='The Art of Computer Programming, Vol 1'; Sub='Fundamental Algorithms'; Pub='Manning Publications';Date='1968-01-01';Pages=672;Lang='English';Price=89.99;Auth=@('Donald Knuth');               Cats=@('Programming')                       },
    @{ T='Domain-Driven Design';     Sub='Tackling Complexity in the Heart of Software';Pub='No Starch Press';Date='2003-08-22';Pages=560;Lang='English';Price=49.99;Auth=@('Eric Evans');                Cats=@('Software Design')                   },
    @{ T='The C Programming Language';Sub=$null;                              Pub='No Starch Press';      Date='1978-02-01'; Pages=272; Lang='English'; Price=39.95; Auth=@('Brian Kernighan','Dennis Ritchie'); Cats=@('Programming')                  },
    @{ T='Giovannis Room';           Sub=$null;                              Pub='HarperCollins';         Date='1956-10-14'; Pages=159; Lang='English'; Price=14.00; Auth=@('James Baldwin');             Cats=@('Literary Fiction')                  },
    @{ T='Their Eyes Were Watching God';Sub=$null;                           Pub='HarperCollins';         Date='1937-09-18'; Pages=219; Lang='English'; Price=13.99; Auth=@('Zora Hurston');              Cats=@('Literary Fiction')                  },
    @{ T='Invisible Cities';         Sub=$null;                              Pub='Simon & Schuster';      Date='1972-11-01'; Pages=165; Lang='English'; Price=14.00; Auth=@('Italo Calvino');             Cats=@('Literary Fiction')                  },
    @{ T='The Remains of the Day';   Sub=$null;                              Pub='Penguin Random House';  Date='1989-05-01'; Pages=258; Lang='English'; Price=15.00; Auth=@('Kazuo Ishiguro');            Cats=@('Literary Fiction')                  },
    @{ T='Kindred';                  Sub=$null;                              Pub='Macmillan Publishers';  Date='1979-06-01'; Pages=287; Lang='English'; Price=15.99; Auth=@('Octavia Butler');            Cats=@('Science Fiction','Literary Fiction')},
    @{ T='American Gods';            Sub=$null;                              Pub='HarperCollins';         Date='2001-06-19'; Pages=635; Lang='English'; Price=18.99; Auth=@('Neil Gaiman');               Cats=@('Fantasy')                           },
    @{ T='The Sandman, Vol 1';       Sub='Preludes and Nocturnes';           Pub='Hachette Book Group';   Date='1991-10-01'; Pages=240; Lang='English'; Price=22.99; Auth=@('Neil Gaiman');               Cats=@('Fantasy')                           }
)

foreach ($b in $books) {
    $isbn = "978-{0}-{1}-{2}-{3}" -f $rand.Next(0,9), $rand.Next(100,999), $rand.Next(10000,99999), $rand.Next(0,9)
    $total = $rand.Next(2, 9)
    $available = $rand.Next(0, $total + 1)
    $sub = if ($null -ne $b.Sub) { Esc $b.Sub } else { 'NULL' }
    $pubId = GetId 'Publishers' 'PublisherName' $b.Pub
    $desc = "$($b.T) is widely regarded as a significant work. This catalog entry includes summary metadata for circulation, fines, and patron requests."
    Exec "INSERT INTO Books (ISBN, Title, Subtitle, PublisherID, PublishedDate, Pages, [Language], AvailableCopies, TotalCopies, RetailPrice, Description) VALUES ($(Esc $isbn), $(Esc $b.T), $sub, $pubId, #$($b.Date)#, $($b.Pages), $(Esc $b.Lang), $available, $total, $($b.Price), $(Esc $desc))"

    $bookId = GetId 'Books' 'Title' $b.T

    # Authors
    $order = 1
    foreach ($fullName in $b.Auth) {
        $parts = $fullName -split ' ', 2
        $afn = $parts[0]; $aln = $parts[1]
        $rs = $conn.Execute("SELECT AuthorID FROM Authors WHERE FirstName = $(Esc $afn) AND LastName = $(Esc $aln)")
        if ($rs.EOF) { throw "Author not found: $fullName" }
        $aid = [int]$rs.Fields.Item(0).Value
        $rs.Close() | Out-Null
        Exec "INSERT INTO BookAuthors (BookID, AuthorID, AuthorOrder) VALUES ($bookId, $aid, $order)"
        $order++
    }

    # Categories (pure N:N)
    foreach ($cn in $b.Cats) {
        $cid = GetId 'BookCategories' 'CategoryName' $cn
        Exec "INSERT INTO BookCategoryAssignments (BookID, CategoryID) VALUES ($bookId, $cid)"
    }
}

# Patrons
$firstNames = @('Olivia','Liam','Emma','Noah','Ava','Ethan','Sophia','Mason','Isabella','James','Mia','Lucas','Amelia','Henry','Harper','Alexander','Evelyn','Benjamin','Charlotte','Daniel','Abigail','Matthew','Elizabeth','David','Avery','Joseph','Sofia','Samuel','Ella','Andrew','Madison','Jackson','Scarlett','Sebastian','Grace','Carter','Chloe','Wyatt','Lily','Jayden','Riley','Aiden','Layla','Zoe','Logan','Nora','Asher','Hazel','Levi','Aria')
$lastNames  = @('Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts')

$patronCount = 50
$existingPatrons = @()  # so we can self-ref ReferredBy
for ($i = 0; $i -lt $patronCount; $i++) {
    $fn = $firstNames[$rand.Next($firstNames.Count)]
    $ln = $lastNames[$rand.Next($lastNames.Count)]
    $mem = "M{0:0000}" -f ($i + 1)
    $email = "$($fn.ToLower()).$($ln.ToLower())$($rand.Next(10,99))@example.org"
    $phone = "({0:000}) {1:000}-{2:0000}" -f $rand.Next(200,999), $rand.Next(200,999), $rand.Next(0,9999)
    $joined = $baseDate.AddDays(-1 * $rand.Next(0, 2000)).ToString('yyyy-MM-dd')
    $by = 2026 - $rand.Next(18, 75)
    $active = if ($rand.Next(0,10) -lt 9) { 1 } else { 0 }
    $referredBy = if ($existingPatrons.Count -gt 0 -and $rand.Next(0,3) -eq 0) {
        $existingPatrons[$rand.Next($existingPatrons.Count)]
    } else { $null }
    $refClause = if ($null -ne $referredBy) { "$referredBy" } else { 'NULL' }
    $notes = if ($rand.Next(0,4) -eq 0) {
        Esc "Long-time patron. Prefers digital holds. Active in the book club."
    } else { 'NULL' }
    Exec "INSERT INTO Patrons (MembershipNumber, FirstName, LastName, Email, Phone, JoinDate, BirthYear, IsActive, ReferredByPatronID, Notes) VALUES ($(Esc $mem), $(Esc $fn), $(Esc $ln), $(Esc $email), $(Esc $phone), #$joined#, $by, $active, $refClause, $notes)"
    $existingPatrons += GetId 'Patrons' 'MembershipNumber' $mem
}

# Patron addresses (1-2 per patron)
$streets = @('Main St','Oak Ave','Maple Dr','Cedar Ln','Pine Rd','Elm St','Washington Blvd','Lincoln Way','Park Ave','Lake Shore Dr')
$cities = @('Seattle','Portland','Chicago','New York','Boston','Austin','Denver','Atlanta','Minneapolis','Pittsburgh','San Diego','Nashville')
$states = @('WA','OR','IL','NY','MA','TX','CO','GA','MN','PA','CA','TN')
$addressCount = 0
foreach ($patronRef in $existingPatrons) {
    $addrCount = if ($rand.Next(0,3) -eq 0) { 2 } else { 1 }
    for ($k = 0; $k -lt $addrCount; $k++) {
        $type = if ($k -eq 0) { 'Home' } else { 'Work' }
        $primary = if ($k -eq 0) { 1 } else { 0 }
        $sIdx = $rand.Next($cities.Count)
        $street = "$($rand.Next(100,9999)) $($streets[$rand.Next($streets.Count)])"
        $line2 = if ($rand.Next(0,4) -eq 0) { Esc "Apt $($rand.Next(1,300))" } else { 'NULL' }
        $zip = "{0:00000}" -f $rand.Next(10000, 99999)
        Exec "INSERT INTO PatronAddresses (PatronID, AddressType, StreetLine1, StreetLine2, City, StateOrProvince, PostalCode, Country, IsPrimary) VALUES ($patronRef, $(Esc $type), $(Esc $street), $line2, $(Esc $cities[$sIdx]), $(Esc $states[$sIdx]), $(Esc $zip), 'USA', $primary)"
        $addressCount++
    }
}

# Loans + LoanEvents
$bookIds = @()
$rs = $conn.Execute('SELECT BookID FROM Books')
while (-not $rs.EOF) { $bookIds += [int]$rs.Fields.Item(0).Value; $rs.MoveNext() | Out-Null }
$rs.Close() | Out-Null

$statuses = @('Active','Returned','Overdue','Lost')
$loanCount = 0
$eventCount = 0

# ~200 loans
for ($i = 0; $i -lt 200; $i++) {
    $patronRef = $existingPatrons[$rand.Next($existingPatrons.Count)]
    $bid = $bookIds[$rand.Next($bookIds.Count)]
    $loanDate = $baseDate.AddDays(-1 * $rand.Next(0, 365))
    $dueDate = $loanDate.AddDays(21)
    $renewals = [byte]$rand.Next(0, 4)

    $statusRoll = $rand.Next(0, 10)
    if ($statusRoll -lt 5) {
        $status = 'Returned'
        $returnDate = $loanDate.AddDays($rand.Next(1, 30))
        $fine = if ($returnDate -gt $dueDate) { [math]::Round(($returnDate - $dueDate).Days * 0.25, 2) } else { 0 }
    } elseif ($statusRoll -lt 8) {
        $status = 'Active'
        $returnDate = $null
        $fine = 0
    } elseif ($statusRoll -lt 9) {
        $status = 'Overdue'
        $returnDate = $null
        $fine = [math]::Round(($baseDate - $dueDate).Days * 0.25, 2)
        if ($fine -lt 0) { $fine = 0 }
    } else {
        $status = 'Lost'
        $returnDate = $null
        $fine = 25.00
    }

    $loanStr = $loanDate.ToString('yyyy-MM-dd')
    $dueStr  = $dueDate.ToString('yyyy-MM-dd')
    $retStr  = if ($null -ne $returnDate) { "#$($returnDate.ToString('yyyy-MM-dd'))#" } else { 'NULL' }

    Exec "INSERT INTO Loans (PatronID, BookID, LoanDate, DueDate, ReturnDate, RenewalCount, FineAmount, [Status]) VALUES ($patronRef, $bid, #$loanStr#, #$dueStr#, $retStr, $renewals, $fine, $(Esc $status))"
    $loanCount++

    # Get the inserted LoanID -- use highest LoanID for this patron+book+loan date pair
    $rs2 = $conn.Execute("SELECT MAX(LoanID) FROM Loans WHERE PatronID = $patronRef AND BookID = $bid")
    $loanId = [int]$rs2.Fields.Item(0).Value
    $rs2.Close() | Out-Null

    # Events: always a Checkout event; sometimes Renewal(s); Return/Overdue/Lost terminal event
    Exec "INSERT INTO LoanEvents (LoanID, EventDate, EventType, Notes) VALUES ($loanId, #$loanStr#, 'Checkout', $(Esc 'Initial checkout at branch.'))"
    $eventCount++

    for ($r = 0; $r -lt $renewals; $r++) {
        $renewDate = $loanDate.AddDays(($r + 1) * 21 - $rand.Next(1, 5)).ToString('yyyy-MM-dd')
        Exec "INSERT INTO LoanEvents (LoanID, EventDate, EventType, Notes) VALUES ($loanId, #$renewDate#, 'Renewal', $(Esc 'Patron renewed online.'))"
        $eventCount++
    }

    if ($status -eq 'Returned' -and $null -ne $returnDate) {
        Exec "INSERT INTO LoanEvents (LoanID, EventDate, EventType, Notes) VALUES ($loanId, #$($returnDate.ToString('yyyy-MM-dd'))#, 'Return', $(Esc 'Returned at front desk.'))"
        $eventCount++
    } elseif ($status -eq 'Overdue') {
        $overdueDate = $dueDate.AddDays(1).ToString('yyyy-MM-dd')
        Exec "INSERT INTO LoanEvents (LoanID, EventDate, EventType, Notes) VALUES ($loanId, #$overdueDate#, 'Overdue', $(Esc 'Marked overdue by nightly job.'))"
        $eventCount++
    } elseif ($status -eq 'Lost') {
        $lostDate = $dueDate.AddDays(30).ToString('yyyy-MM-dd')
        Exec "INSERT INTO LoanEvents (LoanID, EventDate, EventType, Notes) VALUES ($loanId, #$lostDate#, 'Lost', $(Esc 'Patron reported lost; replacement fee charged.'))"
        $eventCount++
    }
}

$conn.Close() | Out-Null
$conn = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

$size = (Get-Item $OutFile).Length
Write-Host ""
Write-Host "OK Created $OutFile ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
Write-Host "  Publishers:              $($pubs.Count)"
Write-Host "  Authors:                 $($authors.Count)"
Write-Host "  BookCategories:          $($rootCats.Count + $childCats.Count)  (with parent self-FK)"
Write-Host "  Books:                   $($books.Count)"
Write-Host "  BookAuthors:             N:N w/ AuthorOrder column"
Write-Host "  BookCategoryAssignments: pure N:N junction"
Write-Host "  Patrons:                 $patronCount  (with ReferredBy self-FK)"
Write-Host "  PatronAddresses:         $addressCount"
Write-Host "  Loans:                   $loanCount"
Write-Host "  LoanEvents:              $eventCount"
