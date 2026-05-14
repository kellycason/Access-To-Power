import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Body1,
  Caption1,
  Title3,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Dropdown,
  Option,
  Input,
  Checkbox,
  Tab,
  TabList,
  makeStyles,
} from "@fluentui/react-components";
import {
  findExistingTableMatches,
  suggestExistingColumnMappings,
  type ExistingTableMatch,
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
  "Uniqueidentifier",
  "Lookup",
  "Choice",
];

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  tabs: { marginBottom: "8px" },
  tableTarget: { display: "grid", gridTemplateColumns: "minmax(220px, 360px) 1fr", gap: "12px", alignItems: "end" },
  targetSummary: { display: "flex", flexDirection: "column", gap: "4px" },
  actions: { display: "flex", justifyContent: "space-between" },
});

interface Props {
  manifest: AccessSchemaManifest;
  initialPlan: MigrationPlan | null;
  onPlanReady: (plan: MigrationPlan) => void;
  onBack: () => void;
}

/**
 * Step 3 — Map. User reviews + edits the proposed mapping per table.
 */
export function MapStep({ manifest, initialPlan, onPlanReady, onBack }: Props) {
  const styles = useStyles();
  const defaultPlan = useMemo(() => buildDefaultPlan(manifest, "acp"), [manifest]);
  const [plan, setPlan] = useState<MigrationPlan>(
    () => initialPlan ?? defaultPlan,
  );
  const [activeTable, setActiveTable] = useState<string>(
    plan.tableMappings[0]?.accessTable ?? "",
  );
  const [envUrl, setEnvUrl] = useState<string | null>(null);
  const [matches, setMatches] = useState<Record<string, ExistingTableMatch[]>>({});
  const [matchStatus, setMatchStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!plan.tableMappings.find((t) => t.accessTable === activeTable)) {
      setActiveTable(plan.tableMappings[0]?.accessTable ?? "");
    }
  }, [plan, activeTable]);

  const current = plan.tableMappings.find((t) => t.accessTable === activeTable);
  const currentMatches = current ? matches[current.accessTable] ?? [] : [];

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
    if (!envUrl || !current || matches[current.accessTable]) return;
    const controller = new AbortController();
    setMatchStatus((prev) => ({ ...prev, [current.accessTable]: "Searching existing Dataverse tables..." }));
    findExistingTableMatches({
      envUrl,
      accessTableName: current.accessTable,
      signal: controller.signal,
    })
      .then((found) => {
        setMatches((prev) => ({ ...prev, [current.accessTable]: found }));
        setMatchStatus((prev) => ({
          ...prev,
          [current.accessTable]: found.length > 0 ? `${found.length} possible matches found.` : "No close existing-table matches found.",
        }));
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        setMatchStatus((prev) => ({ ...prev, [current.accessTable]: message }));
      });
    return () => controller.abort();
  }, [current, envUrl, matches]);

  function updateTable(next: TableMapping) {
    setPlan({
      ...plan,
      tableMappings: plan.tableMappings.map((t) =>
        t.accessTable === next.accessTable ? next : t,
      ),
    });
  }

  async function selectExistingTable(match: ExistingTableMatch) {
    if (!current || !envUrl) return;
    setMatchStatus((prev) => ({ ...prev, [current.accessTable]: `Mapping columns to ${match.displayName}...` }));
    const fields = await suggestExistingColumnMappings(
      envUrl,
      match.logicalName,
      current.fields,
    );
    updateTable({
      ...current,
      targetMode: "existing",
      dataverseSchemaName: match.logicalName,
      dataverseDisplayName: match.displayName,
      dataversePluralName: match.displayCollectionName,
      dataverseEntitySetName: match.entitySetName,
      fields,
    });
    setMatchStatus((prev) => ({ ...prev, [current.accessTable]: `Using existing table ${match.displayName}.` }));
  }

  function selectNewTable() {
    if (!current) return;
    const original = defaultPlan.tableMappings.find((t) => t.accessTable === current.accessTable);
    if (original) updateTable(original);
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
          <div className={styles.tableTarget}>
            <Dropdown
              value={current.targetMode === "existing" ? current.dataverseDisplayName : "Create new Dataverse table"}
              selectedOptions={[current.targetMode === "existing" ? current.dataverseSchemaName : "__new"]}
              onOptionSelect={(_e, d) => {
                if (d.optionValue === "__new") {
                  selectNewTable();
                  return;
                }
                const match = currentMatches.find((candidate) => candidate.logicalName === d.optionValue);
                if (match) void selectExistingTable(match);
              }}
            >
              <Option value="__new">Create new Dataverse table</Option>
              {currentMatches.map((match) => (
                <Option
                  key={match.logicalName}
                  value={match.logicalName}
                  text={`${match.displayName} (${match.logicalName})`}
                >
                  {match.displayName} ({match.logicalName})
                </Option>
              ))}
            </Dropdown>
            <div className={styles.targetSummary}>
              <Input
                value={current.dataverseSchemaName}
                disabled={current.targetMode === "existing"}
                onChange={(_e, d) =>
                  updateTable({ ...current, dataverseSchemaName: d.value })
                }
              />
              <Caption1>{matchStatus[current.accessTable] ?? "Existing-table matches load when this tab is opened."}</Caption1>
            </div>
          </div>
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
                    <Input
                      value={f.dataverseSchemaName}
                      disabled={current.targetMode === "existing"}
                      onChange={(_e, d) => {
                        const fields = [...current.fields];
                        fields[i] = { ...f, dataverseSchemaName: d.value };
                        updateTable({ ...current, fields });
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Dropdown
                      value={f.dataverseType}
                      selectedOptions={[f.dataverseType]}
                      disabled={current.targetMode === "existing"}
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
                  </TableCell>
                  <TableCell>{f.targetMode === "existing" ? "Existing column" : "New column"}</TableCell>
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
        </>
      )}
      <div className={styles.actions}>
        <Button onClick={onBack}>Back</Button>
        <Button appearance="primary" onClick={() => onPlanReady(plan)}>
          Save plan & continue
        </Button>
      </div>
    </div>
  );
}
