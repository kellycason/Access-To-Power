# MCP Experiment — Duplicate Workspace Plan

**Status:** Decisions locked May 2026. Ready to execute fork + cloud-isolation renames.

## Goal
Stand up an isolated experimental fork of Access-To-Power to explore replacing/augmenting the static helper logic with two MCP servers:

- `access-inspector` — exposes Access DB schema/sample/pattern tools
- `dataverse-architect` — exposes Dataverse schema design/validate/commit tools

The existing **Access-To-Power** workspace must remain fully functional and untouched. All experimentation happens in a parallel workspace with parallel cloud artifacts.

## Decisions (locked in)

### Workspace isolation
| # | Question | Answer |
|---|---|---|
| 1 | Isolation strategy | **Option 1 — sibling folder copy** (full disk-level copy, fully independent) |
| 2 | New folder name | `Access-To-Power-MCP` (sibling of `Access-To-Power` under `repos/`) |
| 3 | Git | Assistant's call → **fresh `git init` in the copy** (clean history, no risk of accidental push to the working repo's remote). Original `.git/` will be excluded from the copy. |
| 4 | Cloud isolation | **Yes** — re-init Code App ID, rename Dataverse solution + publisher prefix, rename helper protocol scheme so deploys from the copy cannot touch the production app. |

### Architecture (locked May 2026)
| # | Question | Answer |
|---|---|---|
| A1 | Where does the LLM client live? | **Embedded in the Code App UI** — Code App owns the chat/review surface customers see. |
| A2 | Transport: how does Code App reach LLM + MCP servers given CSP blocks `fetch`? | **Helper hosts the MCP runtime + LLM call.** Code App talks to helper via the existing annotation data plane on `acp_migrationjob` (writes `review-request.json`, polls `review-result.json`). Helper spawns MCP servers as **stdio child processes**. No new ports, no firewall prompts, no fight with CSP. |
| A3 | LLM provider & key model | **BYO endpoint + key.** Customer picks Azure OpenAI / OpenAI / Anthropic / Bedrock / any OpenAI-compatible. Endpoint URL + model/deployment name → Dataverse env variable (non-secret, shareable across users in the env). API key → **Windows Credential Manager via helper (DPAPI)**, per-user-per-machine, never in Dataverse. |
| A4 | MCP server distribution | **Bundled as embedded executables inside the helper installer zip.** Customers do not deploy anything new to Azure. Solution import gives them the tables + Code App + env-variable placeholders; helper install gives them MCP runtime + first-run config UI for endpoint/key. |
| A5 | Static vs. AI-judgment split | **Static is default. AI escalates only on the ambiguous tail.** Customer always sees AI output as a *proposal* in MapStep; never silently changes the plan. |

### Static path (no AI)
- Short Text / Long Text / Memo when source-declared length is unambiguous AND sample max length ≤ declared max with safe headroom
- Integer, BigInt, Decimal, Currency, Double when range fits cleanly
- Boolean, GUID, DateTime, DateOnly (existing detection)
- Single-column FK with PK-name match → lookup
- Booleans, autonumbers, identity passthrough

### AI-reviewed escalations
- **Text-length headroom** — column name + declared max + sampled max + semantic hint (`Description`, `Notes`, `Comments`, `Address2`, `Subject`, `Body`, JSON/XML payload, `Reason`) → recommend keep-as-is / widen to safer ceiling / promote Short Text → Memo. Catches the 1990s-schema-leftover problem where someone typed `50` once and never revisited.
- Low-cardinality text → potentially Choice
- Memo with markup → potentially RichText
- Single/Double exceeding Decimal precision → keep Float vs widen Decimal
- MVL (multi-value lookup) → Choice multi-select mapping
- OLE Object → skip vs File column
- Calculated fields → snapshot value vs preserve formula (and how)
- Lookup-Wizard text columns that aren't FK-modeled
- Self-referential candidates (`ParentID`, `ReportsTo`, etc.)
- N:N junction confirmation (planBuilder detects structurally; AI confirms intent)
- Sanitization collisions (which colliding column keeps the unsuffixed name)
- Ambiguous source names (`dt_crt` → `created_on`?, `qty_oh` → `quantity_on_hand`?)

## Execution checklist (do when resumed)

### Disk-level duplication
- [ ] Copy `c:\Users\kellycason\source\repos\Access-To-Power` → `c:\Users\kellycason\source\repos\Access-To-Power-MCP`
- [ ] Exclude during copy: `.git/`, `node_modules/`, `dist/`, `helper/bin/`, `helper/obj/`, `artifacts/`
- [ ] In the new folder: `git init`, initial commit "Fork from Access-To-Power for MCP experiment"

### Rename cloud artifacts in the copy
- [ ] `package.json` → `name`: `access-to-power-mcp`
- [ ] `README.md` title + intro
- [ ] `power.config.json` → new `appId` (delete and `pac code init` fresh)
- [ ] `dataverse/01_create_publisher_and_solution.ps1` → new publisher prefix (e.g., `acpm`) and solution name (e.g., `AccessToPowerMCP`)
- [ ] `helper/AccessToPower.Helper.csproj` → AssemblyName/RootNamespace optional; keep namespaces simple
- [ ] `helper/register-protocol.ps1` → protocol scheme `accesstopowermcp://` (so both helpers can coexist)
- [ ] Any hard-coded references to the original protocol scheme in:
  - `helper/Protocol/LaunchArgs.cs`
  - `src/services/` launcher
  - `INSTALL.md`
  - `docs/install.html`
- [ ] Vite `base` / output filenames — leave alone unless they collide
- [ ] VS Code workspace file (if any) → new name

### Sanity check before any experimentation
- [ ] `npm install` in the copy
- [ ] `dotnet build helper/AccessToPower.Helper.csproj`
- [ ] `npx tsc --noEmit -p tsconfig.app.json`
- [ ] Run helper installer with new scheme; confirm protocol launch works
- [ ] Deploy to a **non-production env** and confirm it creates new solution `AccessToPowerMCP` with prefix `acpm_` — and does NOT touch the production solution

### Then (separate phase) — start MCP work
- [ ] Add `mcp/` folder
- [ ] Build `access-inspector` MCP server (likely .NET, wraps existing `AccessReader`/`DaoEnricher`)
- [ ] Build `dataverse-architect` MCP server (wraps `SchemaCreator`/`Validator`/`DataverseClient`)
- [ ] Decide host: VS Code Copilot, Claude Desktop, or in-app
- [ ] Define tool surface (see brainstorm in conversation history — `list_tables`, `describe_table`, `sample_rows`, `detect_pattern`, `propose_column`, `validate_schema_plan`, `dryrun_create_table`, `commit_table`, etc.)
- [ ] Hybrid model: static helper remains the default path; MCP is invoked for "review with AI" / ambiguous-case escalation / natural-language Q&A

## Guardrails

- Production app `Access-To-Power` is **read-only** during this experiment unless we backport a proven win.
- Production Dataverse solution `AccessToPower` and prefix `acp_` are **off limits** to the experimental code.
- If the experiment fails: delete the `Access-To-Power-MCP` folder. Nothing else to clean up.
- If the experiment succeeds: cherry-pick changes back into `Access-To-Power` deliberately, not via merge.

## Open questions for future-me
- Determinism vs. judgment tradeoff calibration — start conservative (AI only on the explicit escalation list above) and expand based on real customer-DB hit rates.
- Token-cost telemetry — log per-review token counts so customers can budget. Helper writes to a local log only (never to Dataverse — PII risk in sample rows the AI sees).
- Sample-row redaction — AI sees sample values to make judgments. For sensitive customer DBs, MapStep needs a "redact PII before AI review" toggle. Helper redacts in-process; raw samples never leave the customer machine except to their chosen LLM endpoint.
- Failure mode when LLM is unreachable — degrade gracefully to static-only with a "skipped AI review" badge on the MapStep row, never block migration.
