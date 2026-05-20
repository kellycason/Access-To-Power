import { useMemo, useState } from "react";
import {
  makeStyles,
  shorthands,
  tokens,
  Title2,
  Subtitle2,
  Body1,
} from "@fluentui/react-components";
import { ConnectStep } from "./steps/ConnectStep";
import { ScanStep } from "./steps/ScanStep";
import { MapStep } from "./steps/MapStep";
import { MigrateStep } from "./steps/MigrateStep";
import { ValidateStep } from "./steps/ValidateStep";
import { WizardNav } from "./components/WizardNav";
import type { AccessSchemaManifest, MigrationPlan } from "./types/manifest";
import type { ValidationReport } from "./services/validator";

export type WizardStep = "connect" | "scan" | "map" | "migrate" | "validate";

const STEPS: WizardStep[] = ["connect", "scan", "map", "migrate", "validate"];

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: {
    ...shorthands.padding("20px", "32px"),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  body: {
    display: "flex",
    flex: 1,
    minHeight: 0,
  },
  side: {
    width: "260px",
    ...shorthands.padding("24px", "20px"),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
  },
  main: {
    flex: 1,
    minWidth: 0,
    ...shorthands.padding("24px", "32px"),
    overflowY: "auto",
  },
});

export function App() {
  const styles = useStyles();
  const [step, setStep] = useState<WizardStep>("connect");
  const [jobName, setJobName] = useState<string>("");
  const [manifest, setManifest] = useState<AccessSchemaManifest | null>(null);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [migrationJobId, setMigrationJobId] = useState<string | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);

  const currentIndex = useMemo(() => STEPS.indexOf(step), [step]);

  function goNext() {
    const next = STEPS[currentIndex + 1];
    if (next) setStep(next);
  }
  function goPrev() {
    const prev = STEPS[currentIndex - 1];
    if (prev) setStep(prev);
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <Title2 as="h1">Access to Power</Title2>
        <Body1>Migrate Microsoft Access databases to Microsoft Dataverse.</Body1>
      </header>
      <div className={styles.body}>
        <nav className={styles.side}>
          <Subtitle2 block style={{ marginBottom: 12 }}>
            Migration steps
          </Subtitle2>
          <WizardNav steps={STEPS} current={step} onSelect={setStep} />
        </nav>
        <main className={styles.main}>
          {step === "connect" && (
            <ConnectStep
              jobName={jobName}
              onJobNameChange={setJobName}
              onJobCreated={(id) => {
                setMigrationJobId(id);
                goNext();
              }}
            />
          )}
          {step === "scan" && (
            <ScanStep
              migrationJobId={migrationJobId}
              onManifestReady={(m) => {
                setManifest(m);
                goNext();
              }}
              onBack={goPrev}
            />
          )}
          {step === "map" && manifest && (
            <MapStep
              manifest={manifest}
              migrationJobId={migrationJobId}
              initialPlan={plan}
              onPlanReady={(p) => {
                setPlan(p);
                goNext();
              }}
              onBack={goPrev}
            />
          )}
          {step === "migrate" && plan && (
            <MigrateStep
              plan={plan}
              migrationJobId={migrationJobId}
              onCompleted={(report) => {
                setValidationReport(report);
                goNext();
              }}
              onBack={goPrev}
            />
          )}
          {step === "validate" && (
            <ValidateStep
              migrationJobId={migrationJobId}
              report={validationReport}
              onBack={goPrev}
              onRestart={() => {
                setStep("connect");
                setManifest(null);
                setPlan(null);
                setMigrationJobId(null);
                setJobName("");
                setValidationReport(null);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
