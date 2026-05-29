import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox } from "../ui/Checkbox";
import { ConfirmModal } from "../ui/Modal";
import { HelperLaunchModal } from "../ui/HelperLaunchModal";
import { HelperWaitingPanel } from "../ui/HelperWaitingPanel";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Table, THead, TBody, TR, TH, TD } from "../ui/Table";
import { Tooltip, InfoIcon } from "../ui/Tooltip";
import { cx } from "../ui/cx";
import {
  listExistingDataverseTables,
  suggestExistingColumnMappings,
  toDataverseType,
  isSchemaSnapshotMissing,
  EXISTING_TABLES_SNAPSHOT_MISSING,
  type ExistingDataverseTable,
  type SchemaSnapshot,
  type SchemaSnapshotColumn,
} from "../services/existingDataverse";
import { getDataverseClient } from "../services/dataverseClient";
import { buildDefaultPlan } from "../services/planBuilder";
import type {
  AccessSchemaManifest,
  DataverseAttributeType,
  MigrationPlan,
  TableMapping,
} from "../types/manifest";

const DV_TYPES: DataverseAttributeType[] = [
  "String",
  "Memo",
  "Integer",
  "BigInt",
  "Decimal",
  "Money",
  "Double",
  "DateTime",
  "Boolean",
];

/** Dataverse types the user can pick for an Access binary column. */
const BINARY_DV_TYPES: DataverseAttributeType[] = [
  "File",
  "Image",
  "NoteAttachment",
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * User-facing labels for each Dataverse attribute type. We keep the internal
 * identifiers (used in plan JSON + schema creator) but render the names a
 * Power Apps maker would recognize from the "Add column" experience —
 * otherwise mapping looks like a code mode dump.
 */
const DV_TYPE_LABELS: Record<DataverseAttributeType, string> = {
  String: "Text",
  Memo: "Multiline Text",
  Integer: "Whole Number",
  BigInt: "Big Integer",
  Decimal: "Decimal Number",
  Money: "Currency",
  Double: "Float Number",
  DateTime: "Date and Time",
  DateOnly: "Date Only",
  Boolean: "Yes/No",
  Lookup: "Lookup",
  Choice: "Choice",
  Uniqueidentifier: "Unique Identifier",
  File: "File",
  Image: "Image",
  NoteAttachment: "Note Attachment",
};

/**
 * Dataverse only accepts these attribute types as alternate-key components.
 * Memo, Money, Double, Boolean, File, Lookup-on-self, etc. are not eligible.
 */
const ALT_KEY_ELIGIBLE_TYPES: DataverseAttributeType[] = [
  "String",
  "Integer",
  "DateTime",
  "Decimal",
];

function filterTables(tables: ExistingDataverseTable[], query: string): ExistingDataverseTable[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables.slice(0, 200);
  return tables
    .filter(
      (t) =>
        t.logicalName.toLowerCase().includes(q) ||
        t.schemaName.toLowerCase().includes(q) ||
        t.displayName.toLowerCase().includes(q) ||
        t.displayCollectionName.toLowerCase().includes(q),
    )
    .slice(0, 200);
}

interface Props {
  manifest: AccessSchemaManifest;
  migrationJobId: string | null;
  initialPlan: MigrationPlan | null;
  onPlanReady: (plan: MigrationPlan) => void;
  onBack: () => void;
}

export function MapStep({ manifest, migrationJobId, initialPlan, onPlanReady, onBack }: Props) {
  // The publisher prefix the user chose in the Connect step. We have to fetch
  // it from the migration job because the prefix gets baked into every new
  // table's schema name (publisher prefix => tables: `${prefix}_categories`).
  // Until the prefix is known we fall back to "acp" so the wizard still
  // renders, but we re-build the default plan once the real prefix arrives
  // (see effect below). If the user is resuming with an existing plan, the
  // prefix is already encoded in the saved schema names and no rebuild needed.
  const [publisherPrefix, setPublisherPrefix] = useState<string>("acp");
  const [prefixLoaded, setPrefixLoaded] = useState<boolean>(initialPlan != null);
  const defaultPlan = useMemo(
    () => buildDefaultPlan(manifest, publisherPrefix),
    [manifest, publisherPrefix],
  );
  const [plan, setPlan] = useState<MigrationPlan>(() => initialPlan ?? defaultPlan);
  const [activeTable, setActiveTable] = useState<string>(plan.tableMappings[0]?.accessTable ?? "");
  const [envUrl, setEnvUrl] = useState<string | null>(null);
  const [existingTables, setExistingTables] = useState<ExistingDataverseTable[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [tableListError, setTableListError] = useState<string | null>(null);
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const [snapshot, setSnapshot] = useState<SchemaSnapshot | null>(null);
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [matchStatus, setMatchStatus] = useState<Record<string, string>>({});
  const snapshotPollTimer = useRef<number | null>(null);
  const [tableQuery, setTableQuery] = useState<string>("");
  const [pendingStandardTable, setPendingStandardTable] = useState<ExistingDataverseTable | null>(
    null,
  );
  const [snapshotLaunchUrl, setSnapshotLaunchUrl] = useState<string | null>(null);
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);

  useEffect(() => {
    if (!plan.tableMappings.find((t) => t.accessTable === activeTable)) {
      setActiveTable(plan.tableMappings[0]?.accessTable ?? "");
    }
  }, [plan, activeTable]);

  const current = plan.tableMappings.find((t) => t.accessTable === activeTable);

  // Look up the manifest column for the active row so we can surface
  // detected MIME type / sample size hints next to binary mappings.
  const currentManifestTable = current
    ? manifest.tables.find((t) => t.name === current.accessTable)
    : undefined;
  const accessColumnByName = useMemo(() => {
    const m: Record<string, (typeof manifest)["tables"][number]["columns"][number]> = {};
    if (currentManifestTable) {
      for (const c of currentManifestTable.columns) m[c.name] = c;
    }
    return m;
  }, [currentManifestTable]);

  // Detect plan-vs-environment collisions: any "create new" mapping whose
  // logical name is already in use by another table in this environment.
  // Without this check the helper would silently merge migrated rows into the
  // existing table (we have hit this before with leftover acp_order rows from
  // a prior run getting augmented instead of replaced).
  const newTableCollisions = useMemo<Record<string, ExistingDataverseTable>>(() => {
    if (!tablesLoaded || existingTables.length === 0) return {};
    const byLogical = new Map(existingTables.map((t) => [t.logicalName.toLowerCase(), t]));
    const out: Record<string, ExistingDataverseTable> = {};
    for (const t of plan.tableMappings) {
      if (t.action === "Skip") continue;
      if (t.targetMode === "existing") continue;
      const ln = t.dataverseSchemaName?.toLowerCase().trim();
      if (!ln) continue;
      const match = byLogical.get(ln);
      if (match) out[t.accessTable] = match;
    }
    return out;
  }, [plan, existingTables, tablesLoaded]);

  const isPlanValid = useMemo(
    () =>
      plan.tableMappings.every(
        (t) => t.action === "Skip" || t.targetMode !== "existing" || Boolean(t.dataverseSchemaName),
      ) && Object.keys(newTableCollisions).length === 0,
    [plan, newTableCollisions],
  );

  const existingTableColumns = useMemo<SchemaSnapshotColumn[]>(() => {
    if (!current || current.targetMode !== "existing" || !current.dataverseSchemaName || !snapshot)
      return [];
    const table = snapshot.tables.find((t) => t.logicalName === current.dataverseSchemaName);
    if (!table) return [];
    return table.columns
      .filter((column) => column.isValidForCreate && !column.isPrimaryId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [current, snapshot]);

  useEffect(() => {
    let cancelled = false;
    getDataverseClient()
      .getContext()
      .then((context) => {
        if (!cancelled) setEnvUrl(context.environmentUrl);
      })
      .catch(() => {
        if (!cancelled) setEnvUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the publisher prefix from the migration job. Don't refetch when
  // resuming from a saved plan — the prefix is already baked into its schema
  // names and replacing them would silently lose the user's edits.
  useEffect(() => {
    if (initialPlan) {
      setPrefixLoaded(true);
      return;
    }
    if (!migrationJobId) return;
    let cancelled = false;
    getDataverseClient()
      .getJob(migrationJobId)
      .then((job) => {
        if (cancelled) return;
        const p = (job.targetPublisherPrefix || "acp").toLowerCase();
        setPublisherPrefix(p);
        setPrefixLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPrefixLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [migrationJobId, initialPlan]);

  // Once the real prefix arrives (and no saved plan was passed in), rebuild
  // the default plan so every new table's schema name uses the right prefix
  // (e.g. `pp_categories` instead of the hardcoded `acp_categories`).
  useEffect(() => {
    if (initialPlan) return;
    if (!prefixLoaded) return;
    setPlan(buildDefaultPlan(manifest, publisherPrefix));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefixLoaded, publisherPrefix]);

  useEffect(() => {
    if (!migrationJobId) return;
    let cancelled = false;
    getDataverseClient()
      .tryGetSchemaSnapshot(migrationJobId)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [migrationJobId]);

  useEffect(
    () => () => {
      if (snapshotPollTimer.current) window.clearInterval(snapshotPollTimer.current);
    },
    [],
  );

  // Eagerly load the list of existing Dataverse tables as soon as we have a
  // schema snapshot. This is needed so the collision check (see
  // newTableCollisions) can run BEFORE the user opens the "use existing" picker
  // for any table. Otherwise a silent reuse of an existing table would only be
  // caught after the helper fails (and only thanks to the hard-fail guard).
  useEffect(() => {
    if (!snapshot) return;
    void loadExistingTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.tables.length]);

  useEffect(() => {
    if (!current) {
      setTableQuery("");
      return;
    }
    if (current.targetMode === "existing" && current.dataverseSchemaName) {
      setTableQuery(`${current.dataverseDisplayName} (${current.dataverseSchemaName})`);
    } else {
      setTableQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.accessTable, current?.targetMode, current?.dataverseSchemaName]);

  async function captureSnapshot() {
    if (!migrationJobId || capturingSnapshot) return;
    setSnapshotError(null);
    try {
      const client = getDataverseClient();
      const { environmentUrl, tenantId } = await client.getContext();
      const jobSnap = await client.getJob(migrationJobId);
      const url = new URL("accesstopower://launch");
      url.searchParams.set("jobId", migrationJobId);
      url.searchParams.set("env", environmentUrl);
      url.searchParams.set("tenant", tenantId);
      url.searchParams.set("name", jobSnap.name);
      url.searchParams.set("mode", "snapshot");
      setSnapshotLaunchUrl(url.toString());
      setSnapshotModalOpen(true);
    } catch (e) {
      setSnapshotError(e instanceof Error ? e.message : String(e));
    }
  }

  function startSnapshotPolling() {
    if (snapshotPollTimer.current || !migrationJobId) return;
    snapshotPollTimer.current = window.setInterval(() => {
      void refreshSnapshot();
    }, 4000);
  }

  async function refreshSnapshot(): Promise<SchemaSnapshot | null> {
    if (!migrationJobId) return null;
    try {
      const snap = await getDataverseClient().tryGetSchemaSnapshot(migrationJobId);
      setSnapshot(snap);
      if (snap) {
        setSnapshotMissing(false);
        setCapturingSnapshot(false);
        setTablesLoaded(false);
        setExistingTables([]);
        if (snapshotPollTimer.current) {
          window.clearInterval(snapshotPollTimer.current);
          snapshotPollTimer.current = null;
        }
      }
      return snap;
    } catch (e) {
      setSnapshotError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function loadExistingTables() {
    if (tablesLoaded || loadingTables) return;
    const controller = new AbortController();
    setLoadingTables(true);
    setTableListError(null);
    try {
      const liveSnap = snapshot ?? (await refreshSnapshot());
      const context = envUrl ? { environmentUrl: envUrl } : await getDataverseClient().getContext();
      setEnvUrl(context.environmentUrl);
      const tables = await listExistingDataverseTables(context.environmentUrl, liveSnap, controller.signal);
      setExistingTables(tables);
      setTablesLoaded(true);
      setSnapshotMissing(false);
    } catch (e) {
      if (isSchemaSnapshotMissing(e)) {
        setSnapshotMissing(true);
      } else {
        setTableListError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoadingTables(false);
    }
  }

  async function selectExistingTable(table: ExistingDataverseTable) {
    if (!current) return;
    if (!table.isCustomEntity) {
      setPendingStandardTable(table);
      return;
    }
    await applyExistingTable(table);
  }

  async function applyExistingTable(table: ExistingDataverseTable) {
    if (!current) return;
    const context = envUrl ? { environmentUrl: envUrl } : await getDataverseClient().getContext();
    setEnvUrl(context.environmentUrl);
    setMatchStatus((prev) => ({
      ...prev,
      [current.accessTable]: `Mapping columns to ${table.displayName}...`,
    }));
    suggestExistingColumnMappings(context.environmentUrl, table.logicalName, current.fields, snapshot)
      .then((found) => {
        updateTable({
          ...current,
          targetMode: "existing",
          dataverseSchemaName: table.logicalName,
          dataverseDisplayName: table.displayName,
          dataversePluralName: table.displayCollectionName,
          dataverseEntitySetName: table.entitySetName,
          fields: found,
        });
        setMatchStatus((prev) => ({
          ...prev,
          [current.accessTable]: `Using existing table ${table.displayName}.`,
        }));
      })
      .catch(() => {
        setMatchStatus((prev) => ({
          ...prev,
          [current.accessTable]:
            "Could not inspect columns for that existing table. Try another table or create a new Dataverse table.",
        }));
      });
  }

  function updateTable(next: TableMapping) {
    setPlan({
      ...plan,
      tableMappings: plan.tableMappings.map((t) => (t.accessTable === next.accessTable ? next : t)),
    });
  }

  function selectNewTable() {
    if (!current) return;
    const original = defaultPlan.tableMappings.find((t) => t.accessTable === current.accessTable);
    if (original) {
      updateTable(original);
      setMatchStatus((prev) => ({
        ...prev,
        [current.accessTable]: "Creating a new Dataverse table.",
      }));
    }
  }

  function switchToExistingMode() {
    if (!current) return;
    if (current.targetMode !== "existing") {
      updateTable({
        ...current,
        targetMode: "existing",
        dataverseSchemaName: "",
        dataverseDisplayName: "",
        dataversePluralName: "",
        dataverseEntitySetName: "",
      });
      setTableQuery("");
      setMatchStatus((prev) => ({
        ...prev,
        [current.accessTable]: "Pick the Dataverse table to map into.",
      }));
    }
    void loadExistingTables();
  }

  if (!prefixLoaded) {
    return (
      <Card>
        <div className="flex items-center gap-3 text-ink-500">
          <Spinner /> Loading migration job…
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {Object.keys(newTableCollisions).length > 0 && (
        <Alert intent="warning">
          {Object.keys(newTableCollisions).length === 1 ? (
            <>
              The Access table <strong>{Object.keys(newTableCollisions)[0]}</strong> is set to create
              a new Dataverse table, but that name is already taken in this environment. Resolve it
              below before you continue.
            </>
          ) : (
            <>
              {Object.keys(newTableCollisions).length} tables are set to be created new, but their
              names are already taken in this environment:{" "}
              <strong>{Object.keys(newTableCollisions).join(", ")}</strong>. Resolve each one below
              before you continue.
            </>
          )}
        </Alert>
      )}

      {/* Tabs strip */}
      <div className="flex gap-1 overflow-x-auto bg-white border border-ink-200 rounded-xl p-1">
        {plan.tableMappings.map((t) => {
          const isActive = t.accessTable === activeTable;
          const hasCollision = Boolean(newTableCollisions[t.accessTable]);
          return (
            <button
              key={t.accessTable}
              onClick={() => setActiveTable(t.accessTable)}
              className={cx(
                "px-3 py-2 rounded-lg text-sm whitespace-nowrap transition focus-ring",
                isActive
                  ? "bg-brand-50 text-brand-700 font-semibold"
                  : "text-ink-600 hover:bg-ink-50 hover:text-ink-900",
                hasCollision && !isActive && "text-amber-700",
                hasCollision && isActive && "bg-amber-50 text-amber-800",
              )}
            >
              {hasCollision ? "\u26A0 " : ""}
              {t.accessTable}
            </button>
          );
        })}
      </div>

      {current && (
        <>
          <Card>
            <div className="mb-3">
              <div className="text-base font-semibold text-ink-900">
                Where should &ldquo;{current.accessTable}&rdquo; land in Dataverse?
              </div>
              <div className="text-sm text-ink-500 mt-0.5">
                Pick one. You can change this any time before migrating.
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ModeTile
                active={current.targetMode === "new"}
                onClick={() => selectNewTable()}
                title="Create a new Dataverse table"
                description="We'll create the table and all its columns when you migrate."
              />
              <ModeTile
                active={current.targetMode === "existing"}
                onClick={() => switchToExistingMode()}
                title="Use an existing Dataverse table"
                description="Map your Access columns into a table that already lives in this environment."
              />
            </div>

            {current.targetMode === "new" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                <Input
                  label="Schema name"
                  hint="This will be the new table's logical name."
                  value={current.dataverseSchemaName}
                  onChange={(e) => updateTable({ ...current, dataverseSchemaName: e.target.value })}
                />
                <Input
                  label="Display name"
                  value={current.dataverseDisplayName}
                  onChange={(e) =>
                    updateTable({ ...current, dataverseDisplayName: e.target.value })
                  }
                />
              </div>
            )}

            {current.targetMode === "new" && newTableCollisions[current.accessTable] && (
              <div className="mt-4">
                <Alert
                  intent="warning"
                  actions={
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        const match = newTableCollisions[current.accessTable];
                        void applyExistingTable(match);
                      }}
                    >
                      Use existing table
                    </Button>
                  }
                >
                  A table named <strong>{newTableCollisions[current.accessTable].logicalName}</strong>{" "}
                  ({newTableCollisions[current.accessTable].displayName}) already exists in this
                  environment. Creating it again would mix your Access data with whatever is already
                  there. Either map into the existing table, or change the schema name (or pick a
                  different publisher prefix on the Connect step) so a fresh table can be created.
                </Alert>
              </div>
            )}

            {current.targetMode === "existing" && (
              <div className="mt-4 space-y-3">
                <ExistingTablePicker
                  tableQuery={tableQuery}
                  setTableQuery={setTableQuery}
                  loadingTables={loadingTables}
                  tables={existingTables}
                  onOpen={() => void loadExistingTables()}
                  onSelect={(table) => void selectExistingTable(table)}
                  selectedLogicalName={current.dataverseSchemaName}
                />
                {matchStatus[current.accessTable] && (
                  <p className="text-xs text-ink-500">{matchStatus[current.accessTable]}</p>
                )}

                {snapshotMissing && !capturingSnapshot && (
                  <Alert
                    intent="info"
                    actions={
                      <>
                        <Button variant="secondary" size="sm" onClick={() => void refreshSnapshot()} disabled={!migrationJobId}>
                          Check again
                        </Button>
                        <Button variant="primary" size="sm" onClick={captureSnapshot} disabled={!migrationJobId}>
                          Capture snapshot
                        </Button>
                      </>
                    }
                  >
                    {EXISTING_TABLES_SNAPSHOT_MISSING}
                  </Alert>
                )}
                {capturingSnapshot && (
                  <HelperWaitingPanel
                    title="Capturing Dataverse schema"
                    description="The desktop helper is enumerating tables in your environment. The list will appear here automatically."
                    helperUrl={snapshotLaunchUrl}
                    onRelaunch={snapshotLaunchUrl ? () => setSnapshotModalOpen(true) : undefined}
                  />
                )}
                {snapshotError && <Alert intent="warning">Snapshot capture failed: {snapshotError}</Alert>}
                {tableListError && !snapshotMissing && (
                  <Alert intent="warning">Existing tables could not be loaded ({tableListError}).</Alert>
                )}
              </div>
            )}
          </Card>

          {current.targetMode === "existing" && !current.dataverseSchemaName ? (
            <Alert intent="info">Pick a Dataverse table above to start mapping columns.</Alert>
          ) : (
            <Card padding="none">
              <Table>
                <THead>
                  <TR>
                    <TH>Migrate</TH>
                    <TH>Access column</TH>
                    <TH>Dataverse name</TH>
                    <TH>Type</TH>
                    <TH>Target</TH>
                    <TH>
                      <span className="inline-flex items-center gap-1">
                        Alt key
                        <Tooltip
                          content={
                            <span>
                              <strong>Alternate key.</strong> Marks this column as a Dataverse
                              uniqueness constraint and enables idempotent re-runs (upsert by
                              value instead of GUID). Best for natural business keys
                              (e.g. order number, SKU). Only <em>String</em>, <em>Integer</em>,{" "}
                              <em>DateTime</em>, and <em>Decimal</em> columns are eligible.
                            </span>
                          }
                        >
                          <InfoIcon />
                        </Tooltip>
                      </span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {current.fields.map((f, i) => (
                    <TR key={f.accessColumn}>
                      <TD>
                        <Checkbox
                          checked={f.action === "Map"}
                          onChange={(e) => {
                            const fields = [...current.fields];
                            fields[i] = { ...f, action: e.target.checked ? "Map" : "Skip" };
                            updateTable({ ...current, fields });
                          }}
                        />
                      </TD>
                      <TD>{f.accessColumn}</TD>
                      <TD>
                        {current.targetMode === "existing" && f.targetMode === "existing" ? (
                          <Select
                            value={f.dataverseSchemaName}
                            onChange={(e) => {
                              const col = existingTableColumns.find(
                                (c) => c.logicalName === e.target.value,
                              );
                              if (!col) return;
                              const fields = [...current.fields];
                              fields[i] = {
                                ...f,
                                targetMode: "existing",
                                action: "Map",
                                dataverseSchemaName: col.logicalName,
                                dataverseDisplayName:
                                  col.displayName || col.schemaName || col.logicalName,
                                dataverseType: toDataverseType(col.attributeType, f.dataverseType),
                              };
                              updateTable({ ...current, fields });
                            }}
                          >
                            <option value="">— Pick column —</option>
                            {existingTableColumns.map((col) => (
                              <option key={col.logicalName} value={col.logicalName}>
                                {col.displayName} ({col.logicalName})
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            value={f.dataverseSchemaName}
                            onChange={(e) => {
                              const fields = [...current.fields];
                              fields[i] = { ...f, dataverseSchemaName: e.target.value };
                              updateTable({ ...current, fields });
                            }}
                          />
                        )}
                      </TD>
                      <TD>
                        {(() => {
                          const accessCol = accessColumnByName[f.accessColumn];
                          const isAccessBinary =
                            accessCol &&
                            (accessCol.dataType === "Binary" ||
                              accessCol.dataType === "OleObject" ||
                              accessCol.dataType === "Attachment");
                          const isBinaryTarget = BINARY_DV_TYPES.includes(f.dataverseType);
                          // Show a File/Image/NoteAttachment dropdown whenever
                          // the source is binary OR the user previously chose
                          // a binary target. Existing-table mode is read-only
                          // because target attribute type comes from Dataverse.
                          if (
                            (isAccessBinary || isBinaryTarget) &&
                            !(current.targetMode === "existing" && f.targetMode === "existing")
                          ) {
                            const hint = accessCol?.binaryHint;
                            return (
                              <div className="flex flex-col gap-0.5">
                                <Select
                                  value={
                                    BINARY_DV_TYPES.includes(f.dataverseType)
                                      ? f.dataverseType
                                      : (accessCol?.dataType === "Attachment"
                                          ? "NoteAttachment"
                                          : hint?.detectedKind === "image"
                                            ? "Image"
                                            : "File")
                                  }
                                  onChange={(e) => {
                                    const fields = [...current.fields];
                                    fields[i] = {
                                      ...f,
                                      action: "Map",
                                      dataverseType: e.target.value as DataverseAttributeType,
                                    };
                                    updateTable({ ...current, fields });
                                  }}
                                >
                                  {BINARY_DV_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {DV_TYPE_LABELS[t] ?? t}
                                    </option>
                                  ))}
                                </Select>
                                {hint ? (
                                  <span className="text-[10px] text-ink-500">
                                    Detected {hint.detectedKind}
                                    {hint.sampleMime ? ` (${hint.sampleMime})` : ""}
                                    {hint.maxBytes ? ` · up to ${formatBytes(hint.maxBytes)} observed` : ""}
                                    {hint.hasOleWrapper ? " · OLE wrapper" : ""}
                                  </span>
                                ) : isAccessBinary ? (
                                  <span className="text-[10px] text-ink-500">
                                    No sampled bytes — defaulted to File
                                  </span>
                                ) : null}
                              </div>
                            );
                          }
                          return DV_TYPES.includes(f.dataverseType) ? (
                            <Select
                              value={f.dataverseType}
                              disabled={current.targetMode === "existing" && f.targetMode !== "new"}
                              onChange={(e) => {
                                const fields = [...current.fields];
                                fields[i] = {
                                  ...f,
                                  dataverseType: e.target.value as DataverseAttributeType,
                                };
                                updateTable({ ...current, fields });
                              }}
                            >
                              {DV_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {DV_TYPE_LABELS[t] ?? t}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <span className="text-xs text-ink-500">
                              {DV_TYPE_LABELS[f.dataverseType] ?? f.dataverseType}
                              {f.dataverseType === "Lookup" ? " (from relationship)" : ""}
                            </span>
                          );
                        })()}
                      </TD>
                      <TD>
                        {current.targetMode === "existing" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const fields = [...current.fields];
                              if (f.targetMode === "new") {
                                fields[i] = {
                                  ...f,
                                  targetMode: "existing",
                                  dataverseSchemaName: "",
                                  dataverseDisplayName: "",
                                };
                              } else {
                                const original = defaultPlan.tableMappings
                                  .find((t) => t.accessTable === current.accessTable)
                                  ?.fields.find((cf) => cf.accessColumn === f.accessColumn);
                                fields[i] = {
                                  ...f,
                                  targetMode: "new",
                                  action: "Map",
                                  dataverseSchemaName:
                                    original?.dataverseSchemaName ?? f.dataverseSchemaName,
                                  dataverseDisplayName:
                                    original?.dataverseDisplayName ?? f.accessColumn,
                                  dataverseType: original?.dataverseType ?? f.dataverseType,
                                };
                              }
                              updateTable({ ...current, fields });
                            }}
                          >
                            {f.targetMode === "new" ? "↺ Use existing column" : "+ Create new column"}
                          </Button>
                        ) : (
                          <span className="text-xs text-ink-500">New column</span>
                        )}
                      </TD>
                      <TD>
                        {(() => {
                          const eligible = ALT_KEY_ELIGIBLE_TYPES.includes(f.dataverseType);
                          const checkbox = (
                            <Checkbox
                              checked={eligible && f.isAlternateKey}
                              disabled={!eligible}
                              onChange={(e) => {
                                const fields = [...current.fields];
                                fields[i] = { ...f, isAlternateKey: e.target.checked };
                                updateTable({ ...current, fields });
                              }}
                            />
                          );
                          return eligible ? (
                            checkbox
                          ) : (
                            <Tooltip content="Alt keys only support String, Integer, DateTime, and Decimal columns.">
                              <span className="opacity-50 cursor-not-allowed">{checkbox}</span>
                            </Tooltip>
                          );
                        })()}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}
        </>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={() => onPlanReady(plan)} disabled={!isPlanValid}>
          Save plan & continue
        </Button>
      </div>

      <ConfirmModal
        open={!!pendingStandardTable}
        onClose={() => {
          if (current && pendingStandardTable) {
            setMatchStatus((prev) => ({
              ...prev,
              [current.accessTable]: `Cancelled mapping to ${pendingStandardTable.displayName}.`,
            }));
          }
          setPendingStandardTable(null);
        }}
        onConfirm={async () => {
          const table = pendingStandardTable;
          setPendingStandardTable(null);
          if (table) await applyExistingTable(table);
        }}
        title="Use a standard Dataverse table?"
        description={
          pendingStandardTable
            ? `'${pendingStandardTable.displayName}' (${pendingStandardTable.logicalName}) is a standard Dataverse table.`
            : undefined
        }
        confirmLabel="Yes, map into it"
      >
        <p className="text-sm text-ink-700 mb-2">
          Rows from{" "}
          <strong>{current?.accessTable}</strong> will be loaded into it, and any Access columns
          that don't already exist will be added as <strong>new custom columns</strong> on the
          standard table.
        </p>
        <p className="text-sm text-ink-700">
          This is a great way to consolidate multiple Access databases into one shared table — just
          make sure that's what you intend.
        </p>
      </ConfirmModal>

      <HelperLaunchModal
        open={snapshotModalOpen}
        mode="snapshot"
        helperUrl={snapshotLaunchUrl ?? ""}
        onClose={() => setSnapshotModalOpen(false)}
        onLaunched={() => {
          setCapturingSnapshot(true);
          setSnapshotMissing(false);
          setMatchStatus((prev) => ({ ...prev }));
          startSnapshotPolling();
        }}
      />
    </div>
  );
}

function ModeTile({
  active,
  onClick,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "text-left rounded-xl border-2 p-4 transition focus-ring",
        active
          ? "border-brand-500 bg-brand-50"
          : "border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <div
          className={cx(
            "h-4 w-4 rounded-full border-2 flex items-center justify-center transition",
            active ? "border-brand-500 bg-brand-500" : "border-ink-300",
          )}
        >
          {active && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
        </div>
        <div className="text-sm font-semibold text-ink-900">{title}</div>
      </div>
      <div className="text-xs text-ink-500 ml-6">{description}</div>
    </button>
  );
}

interface ExistingTablePickerProps {
  tableQuery: string;
  setTableQuery: (v: string) => void;
  loadingTables: boolean;
  tables: ExistingDataverseTable[];
  onOpen: () => void;
  onSelect: (table: ExistingDataverseTable) => void;
  selectedLogicalName: string;
}

function ExistingTablePicker({
  tableQuery,
  setTableQuery,
  loadingTables,
  tables,
  onOpen,
  onSelect,
  selectedLogicalName,
}: ExistingTablePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filtered = filterTables(tables, tableQuery);

  return (
    <div className="relative" ref={ref}>
      <Input
        label="Dataverse table"
        hint={selectedLogicalName ? "Type to filter or pick a different table." : "Type to filter by display or logical name."}
        placeholder="Select an existing Dataverse table"
        value={tableQuery}
        onChange={(e) => {
          setTableQuery(e.target.value);
          if (!open) {
            setOpen(true);
            onOpen();
          }
        }}
        onFocus={() => {
          setOpen(true);
          onOpen();
        }}
        error={selectedLogicalName ? undefined : "Pick a Dataverse table to continue."}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-white border border-ink-200 rounded-xl shadow-pop">
          {loadingTables && (
            <div className="px-3 py-2 text-sm text-ink-500 flex items-center gap-2">
              <Spinner size={12} /> Loading tables…
            </div>
          )}
          {!loadingTables && filtered.length === 0 && (
            <div className="px-3 py-2 text-sm text-ink-500">No matching tables.</div>
          )}
          {!loadingTables &&
            filtered.map((t) => (
              <button
                key={t.logicalName}
                onClick={() => {
                  setTableQuery(`${t.displayName} (${t.logicalName})`);
                  setOpen(false);
                  onSelect(t);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 transition flex items-center justify-between gap-3"
              >
                <span>
                  <span className="font-medium text-ink-900">{t.displayName}</span>{" "}
                  <span className="text-ink-500 font-mono text-xs">({t.logicalName})</span>
                </span>
                {!t.isCustomEntity && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                    Standard
                  </span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

