import { useEffect, useState } from "react";
import {
  Button,
  Body1,
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
  const [plan, setPlan] = useState<MigrationPlan>(
    () => initialPlan ?? buildDefaultPlan(manifest, "acp"),
  );
  const [activeTable, setActiveTable] = useState<string>(
    plan.tableMappings[0]?.accessTable ?? "",
  );

  useEffect(() => {
    if (!plan.tableMappings.find((t) => t.accessTable === activeTable)) {
      setActiveTable(plan.tableMappings[0]?.accessTable ?? "");
    }
  }, [plan, activeTable]);

  const current = plan.tableMappings.find((t) => t.accessTable === activeTable);

  function updateTable(next: TableMapping) {
    setPlan({
      ...plan,
      tableMappings: plan.tableMappings.map((t) =>
        t.accessTable === next.accessTable ? next : t,
      ),
    });
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
          <Input
            value={current.dataverseSchemaName}
            onChange={(_e, d) =>
              updateTable({ ...current, dataverseSchemaName: d.value })
            }
          />
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Migrate</TableHeaderCell>
                <TableHeaderCell>Access column</TableHeaderCell>
                <TableHeaderCell>Dataverse name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
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
