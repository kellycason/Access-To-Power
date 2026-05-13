import { Button, makeStyles, tokens } from "@fluentui/react-components";
import type { WizardStep } from "../App";

const STEP_LABELS: Record<WizardStep, string> = {
  connect: "1. Connect",
  scan: "2. Scan",
  map: "3. Map",
  migrate: "4. Migrate",
  validate: "5. Validate",
};

const useStyles = makeStyles({
  list: { display: "flex", flexDirection: "column", gap: "4px" },
  item: {
    justifyContent: "flex-start",
    width: "100%",
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
  },
});

interface Props {
  steps: WizardStep[];
  current: WizardStep;
  onSelect: (step: WizardStep) => void;
}

export function WizardNav({ steps, current, onSelect }: Props) {
  const styles = useStyles();
  return (
    <div className={styles.list}>
      {steps.map((s) => (
        <Button
          key={s}
          appearance="subtle"
          className={`${styles.item} ${s === current ? styles.active : ""}`}
          onClick={() => onSelect(s)}
        >
          {STEP_LABELS[s]}
        </Button>
      ))}
    </div>
  );
}
