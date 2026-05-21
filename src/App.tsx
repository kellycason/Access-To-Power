import { useMemo, useState } from "react";
import { ConnectStep } from "./steps/ConnectStep";
import { ScanStep } from "./steps/ScanStep";
import { MapStep } from "./steps/MapStep";
import { MigrateStep } from "./steps/MigrateStep";
import { ValidateStep } from "./steps/ValidateStep";
import { StepProgress } from "./components/StepProgress";
import { Sidebar, type AppRoute } from "./components/Sidebar";
import { HistoryListPage } from "./pages/HistoryListPage";
import { HistoryDetailPage } from "./pages/HistoryDetailPage";
import type { AccessSchemaManifest, MigrationPlan } from "./types/manifest";
import type { ValidationReport } from "./services/validator";

export type WizardStep = "connect" | "scan" | "map" | "migrate" | "validate";

const STEPS: WizardStep[] = ["connect", "scan", "map", "migrate", "validate"];

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  connect: "Name the migration job and pick a target solution.",
  scan: "Launch the desktop helper to scan your Access database.",
  map: "Review the proposed schema mapping for each table.",
  migrate: "Provision the schema and load your data into Dataverse.",
  validate: "Confirm row counts and review the migration report.",
};

export function App() {
  const [route, setRoute] = useState<AppRoute>({ name: "wizard" });
  const [step, setStep] = useState<WizardStep>("connect");
  const [jobName, setJobName] = useState<string>("");
  const [manifest, setManifest] = useState<AccessSchemaManifest | null>(null);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [migrationJobId, setMigrationJobId] = useState<string | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  // Once a migration job has actually started running, backward step navigation
  // is locked. The earlier steps would just re-render their initial form state
  // — they don't restore the in-flight job — and the user could accidentally
  // wipe their context. Locking forces them to use "Start new migration".
  const [migrationStarted, setMigrationStarted] = useState(false);

  const currentIndex = useMemo(() => STEPS.indexOf(step), [step]);

  function goNext() {
    const next = STEPS[currentIndex + 1];
    if (next) setStep(next);
  }
  function goPrev() {
    const prev = STEPS[currentIndex - 1];
    if (prev) setStep(prev);
  }

  function resetWizard() {
    setStep("connect");
    setManifest(null);
    setPlan(null);
    setMigrationJobId(null);
    setJobName("");
    setValidationReport(null);
    setMigrationStarted(false);
  }

  function navigate(route: AppRoute) {
    if (route.name === "wizard") {
      resetWizard();
    }
    setRoute(route);
  }

  return (
    <div className="h-screen flex bg-ink-50">
      <Sidebar route={route} onNavigate={navigate} />

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {route.name === "wizard" && (
          <>
            <header className="bg-white border-b border-ink-200 px-8 py-5">
              <div className="flex items-baseline justify-between gap-6 mb-4">
                <div className="min-w-0">
                  <h1 className="text-xl font-semibold text-ink-900">
                    {jobName ? jobName : "New migration"}
                  </h1>
                  <p className="text-sm text-ink-500 mt-0.5">{STEP_DESCRIPTIONS[step]}</p>
                </div>
              </div>
              <StepProgress
                steps={STEPS}
                current={step}
                onSelect={setStep}
                lockPast={migrationStarted}
              />
            </header>
            <main className="flex-1 overflow-y-auto px-8 py-8">
              <div className="max-w-5xl mx-auto">
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
                    onStarted={() => setMigrationStarted(true)}
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
                    plan={plan}
                    onBack={goPrev}
                    onRestart={resetWizard}
                  />
                )}
              </div>
            </main>
          </>
        )}

        {route.name === "history" && (
          <HistoryListPage
            onOpen={(jobId) => setRoute({ name: "history-detail", jobId })}
            onStartNew={() => {
              resetWizard();
              setRoute({ name: "wizard" });
            }}
          />
        )}

        {route.name === "history-detail" && (
          <HistoryDetailPage
            jobId={route.jobId}
            onBack={() => setRoute({ name: "history" })}
          />
        )}
      </div>
    </div>
  );
}
