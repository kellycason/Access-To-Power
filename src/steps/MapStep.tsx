import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Body1,
  Caption1,
  MessageBar,
  MessageBarBody,
  Title3,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Dropdown,
  Combobox,
  Option,
  Input,
  Field,
  Checkbox,
  Radio,
  RadioGroup,
  Tab,
  TabList,
  Spinner,
  tokens,
  makeStyles,
} from "@fluentui/react-components";
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

// Only types the schema creator can actually build end-to-end for a new column.
// - Lookup: created automatically from detected FKs/relationships, not user-pickable here.
// - Uniqueidentifier: only the system primary key can have this type.
// - Choice: requires option-set authoring + per-row value mapping (planned, not yet supported).
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

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  tabs: { marginBottom: "8px" },
  targetCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  targetHeader: { display: "flex", flexDirection: "column", gap: "2px" },
  modeChoice: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
  },
  modeOption: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px 14px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    transitionProperty: "border-color, background-color",
    transitionDuration: tokens.durationFast,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  modeOptionSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  modeRadioRow: { display: "flex", alignItems: "center", gap: "8px" },
  modeBody: {
    paddingTop: "4px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  modeBodyRow: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, 420px) 1fr",
    gap: "12px",
    alignItems: "end",
  },
  actions: { display: "flex", justifyContent: "space-between" },
});

function filterTables(tables: ExistingDataverseTable[], query: string): ExistingDataverseTable[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables.slice(0, 200);
  return tables
    .filter((t) =>
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

/**
 * Step 3 — Map. User reviews + edits the proposed mapping per table.
 */
export function MapStep({ manifest, migrationJobId, initialPlan, onPlanReady, onBack }: Props) {
  const styles = useStyles();
  const defaultPlan = useMemo(() => buildDefaultPlan(manifest, "acp"), [manifest]);
  const [plan, setPlan] = useState<MigrationPlan>(
    () => initialPlan ?? defaultPlan,
  );
  const [activeTable, setActiveTable] = useState<string>(
    plan.tableMappings[0]?.accessTable ?? "",
  );
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
  const [tableQuery, setTableQuery] = useState<string>(() =>
    initialPlan?.tableMappings.find((t) => t.accessTable === (initialPlan.tableMappings[0]?.accessTable ?? ""))?.targetMode === "existing"
      ? `${initialPlan.tableMappings[0].dataverseDisplayName} (${initialPlan.tableMappings[0].dataverseSchemaName})`
      : "",
  );

  useEffect(() => {
    if (!plan.tableMappings.find((t) => t.accessTable === activeTable)) {
      setActiveTable(plan.tableMappings[0]?.accessTable ?? "");
    }
  }, [plan, activeTable]);

  const current = plan.tableMappings.find((t) => t.accessTable === activeTable);

  const isPlanValid = useMemo(
    () =>
      plan.tableMappings.every(
        (t) => t.action === "Skip" || t.targetMode !== "existing" || Boolean(t.dataverseSchemaName),
      ),
    [plan],
  );

  const existingTableColumns = useMemo<SchemaSnapshotColumn[]>(() => {
    if (!current || current.targetMode !== "existing" || !current.dataverseSchemaName || !snapshot) return [];
    const table = snapshot.tables.find((t) => t.logicalName === current.dataverseSchemaName);
    if (!table) return [];
    return table.columns
      .filter((column) => column.isValidForCreate && !column.isPrimaryId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [current, snapshot]);

  useEffect(() => {
    let cancelled = false;
    getDataverseClient().getContext()
      .then((context) => {
        if (!cancelled) setEnvUrl(context.environmentUrl);
      })
      .catch(() => {
        if (!cancelled) setEnvUrl(null);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!migrationJobId) return;
    let cancelled = false;
    getDataverseClient().tryGetSchemaSnapshot(migrationJobId)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => { cancelled = true; };
  }, [migrationJobId]);

  useEffect(() => () => {
    if (snapshotPollTimer.current) window.clearInterval(snapshotPollTimer.current);
  }, []);

  // Keep the combobox text in sync when the user switches tabs or modes externally.
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
      window.location.href = url.toString();
      setCapturingSnapshot(true);
      setSnapshotMissing(false);
      setMatchStatus((prev) => ({ ...prev }));
      startSnapshotPolling();
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
      // Always re-check the snapshot on dropdown open— the helper may have just uploaded it.
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
    // Informational confirm before mapping into a system (non-custom) entity.
    // Consolidating multiple Access DBs into a shared standard table (e.g.
    // `product`, `account`, `contact`) is a legitimate scenario — we just
    // want the user to acknowledge that any custom columns from the Access
    // table will be added to that standard table.
    if (!table.isCustomEntity) {
      const proceed = window.confirm(
        `'${table.displayName}' (${table.logicalName}) is a standard Dataverse table.\n\n` +
          `Rows from '${current.accessTable}' will be loaded into it, and any Access columns that don't already exist will be added as new custom columns on the standard table.\n\n` +
          `This is a great way to consolidate multiple Access databases into one shared table — just make sure that's what you intend.\n\n` +
          `Continue?`,
      );
      if (!proceed) {
        setMatchStatus((prev) => ({
          ...prev,
          [current.accessTable]: `Cancelled mapping to ${table.displayName}.`,
        }));
        return;
      }
    }
    const context = envUrl ? { environmentUrl: envUrl } : await getDataverseClient().getContext();
    setEnvUrl(context.environmentUrl);
    setMatchStatus((prev) => ({ ...prev, [current.accessTable]: `Mapping columns to ${table.displayName}...` }));
    suggestExistingColumnMappings(
      context.environmentUrl,
      table.logicalName,
      current.fields,
      snapshot,
    )
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
        setMatchStatus((prev) => ({ ...prev, [current.accessTable]: `Using existing table ${table.displayName}.` }));
      })
      .catch(() => {
        setMatchStatus((prev) => ({
          ...prev,
          [current.accessTable]: "Could not inspect columns for that existing table. Try another table or create a new Dataverse table.",
        }));
      });
  }

  function updateTable(next: TableMapping) {
    setPlan({
      ...plan,
      tableMappings: plan.tableMappings.map((t) =>
        t.accessTable === next.accessTable ? next : t,
      ),
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

  return (
    <div className={styles.page}>
      <Title3>Map Access → Dataverse</Title3>
      <Body1>
        Review the proposed schema. Edit names, types, and which columns to
        skip. Decisions are stored on the migration job in Dataverse.
      </Body1>
      <TabList
        className={styles.tabs}
        selectedValue={activeTable}
        onTabSelect={(_e, d) => setActiveTable(String(d.value))}
      >
        {plan.tableMappings.map((t) => (
          <Tab key={t.accessTable} value={t.accessTable}>
            {t.accessTable}
          </Tab>
        ))}
      </TabList>
      {current && (
        <>
          <div className={styles.targetCard}>
            <div className={styles.targetHeader}>
              <Subtitle2>Where should &ldquo;{current.accessTable}&rdquo; land in Dataverse?</Subtitle2>
              <Caption1>Pick one. You can change this any time before migrating.</Caption1>
            </div>
            <RadioGroup
              layout="horizontal"
              value={current.targetMode}
              onChange={(_e, d) => {
                if (d.value === "new") selectNewTable();
                else if (d.value === "existing") switchToExistingMode();
              }}
            >
              <div
                className={`${styles.modeOption}${current.targetMode === "new" ? " " + styles.modeOptionSelected : ""}`}
                onClick={() => selectNewTable()}
                role="button"
                tabIndex={-1}
              >
                <div className={styles.modeRadioRow}>
                  <Radio value="new" label="Create a new Dataverse table" />
                </div>
                <Caption1 style={{ paddingLeft: 28 }}>
                  We&rsquo;ll create the table and all its columns when you migrate.
                </Caption1>
              </div>
              <div
                className={`${styles.modeOption}${current.targetMode === "existing" ? " " + styles.modeOptionSelected : ""}`}
                onClick={() => switchToExistingMode()}
                role="button"
                tabIndex={-1}
              >
                <div className={styles.modeRadioRow}>
                  <Radio value="existing" label="Use an existing Dataverse table" />
                </div>
                <Caption1 style={{ paddingLeft: 28 }}>
                  Map your Access columns into a table that already lives in this environment.
                </Caption1>
              </div>
            </RadioGroup>

            {current.targetMode === "new" && (
              <div className={styles.modeBody}>
                <div className={styles.modeBodyRow}>
                  <Field label="Schema name" hint="This will be the new table's logical name.">
                    <Input
                      value={current.dataverseSchemaName}
                      onChange={(_e, d) =>
                        updateTable({ ...current, dataverseSchemaName: d.value })
                      }
                    />
                  </Field>
                  <Field label="Display name">
                    <Input
                      value={current.dataverseDisplayName}
                      onChange={(_e, d) =>
                        updateTable({ ...current, dataverseDisplayName: d.value })
                      }
                    />
                  </Field>
                </div>
                {current.dataverseDisplayName &&
                  current.accessTable &&
                  current.dataverseDisplayName.toLowerCase() !== current.accessTable.toLowerCase() && (
                    <Caption1>
                      Renamed <strong>{current.accessTable}</strong> &rarr;{" "}
                      <strong>{current.dataverseDisplayName}</strong> (singular) so the Dataverse
                      OData path becomes <code>/{current.dataverseSchemaName}s</code> instead of{" "}
                      <code>/{current.dataverseSchemaName}es</code>. Edit either field to override.
                    </Caption1>
                  )}
                {matchStatus[current.accessTable] && (
                  <Caption1>{matchStatus[current.accessTable]}</Caption1>
                )}
              </div>
            )}

            {current.targetMode === "existing" && (
              <div className={styles.modeBody}>
                <Field
                  label="Dataverse table"
                  hint="Type to filter by display or logical name."
                  required
                  validationState={current.dataverseSchemaName ? "none" : "error"}
                  validationMessage={current.dataverseSchemaName ? undefined : "Pick a Dataverse table to continue."}
                >
                  <Combobox
                    placeholder="Select an existing Dataverse table"
                    freeform
                    clearable
                    value={tableQuery}
                    selectedOptions={current.dataverseSchemaName ? [current.dataverseSchemaName] : []}
                    onChange={(e) => setTableQuery((e.target as HTMLInputElement).value)}
                    onOptionSelect={(_e, d) => {
                      const table = existingTables.find((candidate) => candidate.logicalName === d.optionValue);
                      if (table) {
                        setTableQuery(`${table.displayName} (${table.logicalName})`);
                        void selectExistingTable(table);
                      }
                    }}
                    onOpenChange={(_e, d) => {
                      if (d.open) {
                        void loadExistingTables();
                        setTableQuery("");
                      }
                    }}
                  >
                    {loadingTables && (
                      <Option disabled value="__loading" text="Loading tables...">
                        Loading tables...
                      </Option>
                    )}
                    {filterTables(existingTables, tableQuery).map((table) => (
                      <Option
                        key={table.logicalName}
                        value={table.logicalName}
                        text={`${table.displayName} (${table.logicalName})`}
                      >
                        {table.displayName} ({table.logicalName})
                      </Option>
                    ))}
                    {!loadingTables && existingTables.length > 0 && filterTables(existingTables, tableQuery).length === 0 && (
                      <Option disabled value="__nomatch" text="No matching tables">
                        No matching tables
                      </Option>
                    )}
                  </Combobox>
                </Field>
                <Caption1>
                  {matchStatus[current.accessTable] ?? "Choose the table you want to map your Access columns into."}
                </Caption1>
                {snapshotMissing && !capturingSnapshot && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      {EXISTING_TABLES_SNAPSHOT_MISSING}
                      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                        <Button appearance="primary" onClick={captureSnapshot} disabled={!migrationJobId}>
                          Capture schema snapshot
                        </Button>
                        <Button onClick={() => { void refreshSnapshot(); }} disabled={!migrationJobId}>
                          Check again
                        </Button>
                      </div>
                    </MessageBarBody>
                  </MessageBar>
                )}
                {capturingSnapshot && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <Spinner size="tiny" /> Waiting for the desktop helper to capture and upload the Dataverse schema snapshot...
                      <div style={{ marginTop: 8 }}>
                        <Button onClick={() => { void refreshSnapshot(); }}>Check now</Button>
                      </div>
                    </MessageBarBody>
                  </MessageBar>
                )}
                {snapshotError && (
                  <MessageBar intent="warning">
                    <MessageBarBody>Snapshot capture failed: {snapshotError}</MessageBarBody>
                  </MessageBar>
                )}
                {tableListError && !snapshotMissing && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      Existing tables could not be loaded ({tableListError}).
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            )}
          </div>
          {current.targetMode === "existing" && !current.dataverseSchemaName ? (
            <MessageBar intent="info">
              <MessageBarBody>
                Pick a Dataverse table above to start mapping columns.
              </MessageBarBody>
            </MessageBar>
          ) : (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Migrate</TableHeaderCell>
                <TableHeaderCell>Access column</TableHeaderCell>
                <TableHeaderCell>Dataverse name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>PK / Alt key</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {current.fields.map((f, i) => (
                <TableRow key={f.accessColumn}>
                  <TableCell>
                    <Checkbox
                      checked={f.action === "Map"}
                      onChange={(_e, d) => {
                        const fields = [...current.fields];
                        fields[i] = {
                          ...f,
                          action: d.checked ? "Map" : "Skip",
                        };
                        updateTable({ ...current, fields });
                      }}
                    />
                  </TableCell>
                  <TableCell>{f.accessColumn}</TableCell>
                  <TableCell>
                    {current.targetMode === "existing" && f.targetMode === "existing" ? (
                      <Combobox
                        placeholder="Pick an existing column"
                        selectedOptions={f.dataverseSchemaName ? [f.dataverseSchemaName] : []}
                        value={
                          f.dataverseSchemaName
                            ? `${f.dataverseDisplayName} (${f.dataverseSchemaName})`
                            : ""
                        }
                        onOptionSelect={(_e, d) => {
                          const col = existingTableColumns.find((c) => c.logicalName === d.optionValue);
                          if (!col) return;
                          const fields = [...current.fields];
                          fields[i] = {
                            ...f,
                            targetMode: "existing",
                            action: "Map",
                            dataverseSchemaName: col.logicalName,
                            dataverseDisplayName: col.displayName || col.schemaName || col.logicalName,
                            dataverseType: toDataverseType(col.attributeType, f.dataverseType),
                          };
                          updateTable({ ...current, fields });
                        }}
                      >
                        {existingTableColumns.map((col) => (
                          <Option
                            key={col.logicalName}
                            value={col.logicalName}
                            text={`${col.displayName} (${col.logicalName})`}
                          >
                            {col.displayName} ({col.logicalName})
                          </Option>
                        ))}
                      </Combobox>
                    ) : (
                      <Input
                        value={f.dataverseSchemaName}
                        onChange={(_e, d) => {
                          const fields = [...current.fields];
                          fields[i] = { ...f, dataverseSchemaName: d.value };
                          updateTable({ ...current, fields });
                        }}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {DV_TYPES.includes(f.dataverseType) ? (
                      <Dropdown
                        value={f.dataverseType}
                        selectedOptions={[f.dataverseType]}
                        disabled={current.targetMode === "existing" && f.targetMode !== "new"}
                        onOptionSelect={(_e, d) => {
                          const fields = [...current.fields];
                          fields[i] = {
                            ...f,
                            dataverseType:
                              (d.optionValue as DataverseAttributeType) ??
                              f.dataverseType,
                          };
                          updateTable({ ...current, fields });
                        }}
                      >
                        {DV_TYPES.map((t) => (
                          <Option key={t} value={t}>
                            {t}
                          </Option>
                        ))}
                      </Dropdown>
                    ) : (
                      <Caption1>
                        {f.dataverseType}
                        {f.dataverseType === "Lookup" ? " (from relationship)" : ""}
                      </Caption1>
                    )}
                  </TableCell>
                  <TableCell>
                    {current.targetMode === "existing" ? (
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => {
                          const fields = [...current.fields];
                          if (f.targetMode === "new") {
                            // Switch back to "bind to existing column".
                            fields[i] = {
                              ...f,
                              targetMode: "existing",
                              dataverseSchemaName: "",
                              dataverseDisplayName: "",
                            };
                          } else {
                            // Switch to "create new column on this existing table".
                            const original = defaultPlan.tableMappings
                              .find((t) => t.accessTable === current.accessTable)
                              ?.fields.find((cf) => cf.accessColumn === f.accessColumn);
                            fields[i] = {
                              ...f,
                              targetMode: "new",
                              action: "Map",
                              dataverseSchemaName: original?.dataverseSchemaName ?? f.dataverseSchemaName,
                              dataverseDisplayName: original?.dataverseDisplayName ?? f.accessColumn,
                              dataverseType: original?.dataverseType ?? f.dataverseType,
                            };
                          }
                          updateTable({ ...current, fields });
                        }}
                      >
                        {f.targetMode === "new" ? "↺ Use existing column" : "+ Create new column"}
                      </Button>
                    ) : (
                      <Caption1>New column</Caption1>
                    )}
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      checked={f.isAlternateKey}
                      label="Alt key"
                      onChange={(_e, d) => {
                        const fields = [...current.fields];
                        fields[i] = {
                          ...f,
                          isAlternateKey: Boolean(d.checked),
                        };
                        updateTable({ ...current, fields });
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </>
      )}
      <div className={styles.actions}>
        <Button onClick={onBack}>Back</Button>
        <Button
          appearance="primary"
          onClick={() => onPlanReady(plan)}
          disabled={!isPlanValid}
        >
          Save plan & continue
        </Button>
      </div>
    </div>
  );
}
