# Access to Power

A **Power Apps Code App** that migrates Microsoft Access databases (`.accdb`,
`.mdb`) to **Microsoft Dataverse** — schema, relationships, and data — with
a remediation report for anything that can't move automatically.

> Migrates: **tables, columns, relationships, data**
> Does **NOT** migrate: forms, reports, macros, VBA, queries, attachments, OLE objects

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │            Power Platform (cloud)               │
                    │                                                 │
  ┌────────────┐    │   ┌─────────────────┐    ┌──────────────────┐   │
  │  Browser   │◄──►│   │  Code App (UI)  │◄──►│    Dataverse     │   │
  │  (Entra)   │    │   │  React + Vite   │    │  migration tables│   │
  └────────────┘    │   └────────┬────────┘    │  + manifest blob │   │
                    │            │             │  + customer data │   │
                    │            ▼             └────────┬─────────┘   │
                    │   ┌─────────────────┐             │             │
                    │   │  Cloud flows    │◄────────────┘             │
                    │   │  - CreateSchema │  (status-driven triggers) │
                    │   │  - LoadData     │                           │
                    │   │  - ResolveFKs   │                           │
                    │   │  - Validate     │                           │
                    │   └─────────────────┘                           │
                    └─────────────────────────────────────────────────┘
                                  ▲
                                  │ uploads manifest + NDJSON
        ┌─────────────────────────┴────────────────────────┐
        │              Customer workstation                │
        │  ┌──────────────┐         ┌────────────────────┐ │
        │  │ Access .accdb│ ──────► │  Local helper      │ │
        │  │              │         │  (PAD or .NET tray)│ │
        │  └──────────────┘         │  ACE OLEDB reader  │ │
        │                           └────────────────────┘ │
        └──────────────────────────────────────────────────┘
```

**Code App** owns all UI and orchestration. **Dataverse** is the single
source of truth: it holds migration metadata, the manifest blob, mapping
decisions, the ID-mapping table for lookups, and the migrated customer
data itself. **Cloud flows** do the heavy server-side work. The **local
helper** is intentionally dumb — it just opens the `.accdb` via ACE OLEDB
and uploads what it finds. No product logic runs locally.

## Why a local helper at all?

Browsers cannot read `.accdb` files, and there is no Microsoft-supported
unattended ACE OLEDB runtime for Azure Functions / server-side processes.
A small local component is unavoidable for reading Access binary files.

Two acceptable forms with an identical contract:

1. **PAD flow** (v1 / demo) — Power Automate Desktop reads tables via
   `Read Access table` actions, writes the manifest + NDJSON to disk,
   uploads via the Dataverse connector.
2. **Signed .NET tray app** (v1.5) — invoked from the Code App through an
   `accesstopower://` protocol handler. Same manifest contract.

## Repo layout

```
access-to-power/
├── src/
│   ├── App.tsx               # 5-step wizard shell
│   ├── components/           # WizardNav + shared UI
│   ├── steps/                # Connect / Scan / Map / Migrate / Validate
│   ├── services/             # manifestSource, planBuilder
│   └── types/                # manifest.ts, migration.ts
├── public/
│   └── fixtures/             # Mock manifests for local dev
├── dataverse/
│   └── migration-schema.yml  # acp_migrationjob and friends
├── power.config.json         # Power Apps Code App config
├── vite.config.ts
└── package.json
```

## Dataverse schema (publisher prefix `acp`)

| Table                       | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `acp_migrationjob`          | One end-to-end migration run. Holds manifest + plan blobs. |
| `acp_migrationtable`        | One Access table being migrated. Holds the ID map.         |
| `acp_migrationcolumn`       | One Access column mapping decision.                        |
| `acp_migrationissue`        | Remediation items (Info / Warning / Error).                |
| `acp_migrationlog`          | Time-ordered execution log.                                |
| `acp_fieldmappingdecision`  | Cross-job learned type-mapping suggestions.                |

See [dataverse/migration-schema.yml](dataverse/migration-schema.yml) for
the full attribute list and the four cloud flows that act on these tables.

## Prerequisites

- **Power Apps Premium** license for end users (Code Apps requirement)
- **Dataverse environment** with table creation permissions
- **64-bit Microsoft Access Database Engine** on the workstation running
  the local helper
- Node 20+, npm 10+
- `@microsoft/power-apps` CLI (installed as a dependency)

## Getting started

```powershell
npm install
npm run dev                 # local Vite dev server with mock manifest
# Configure Dataverse target environment, then:
npm run power:init          # one-time, registers the Code App with PP
npm run power:run           # run inside Power Platform
npm run power:push          # build + push to the environment
```

Edit `power.config.json` to point at your environment:

- `region`: `unitedstates`, `gccmoderate`, `europe`, etc.
- `environmentId`: GUID of the target Dataverse environment
- `appId`: filled in by the CLI on first push

## Roadmap

- [x] Wizard scaffold (Connect → Scan → Map → Migrate → Validate)
- [x] Manifest contract (`src/types/manifest.ts`)
- [x] Dataverse migration schema spec (`dataverse/migration-schema.yml`)
- [x] Mock manifest loader for local dev
- [ ] Power Apps SDK wiring (replace mock Dataverse calls in steps)
- [ ] Provisioning script for `acp_*` tables + four cloud flows
- [ ] PAD helper flow (manifest + NDJSON contract)
- [ ] Signed .NET tray helper with `accesstopower://` protocol handler
- [ ] Throttle-aware bulk upsert client (respects `Retry-After`)
- [ ] Two-pass lookup resolver
- [ ] Validation pass: row-count + checksum + foreign-key integrity
- [ ] Remediation report PDF export
