export type CodeModeRunFinalQuiescence = "quiescent" | "non_quiescent" | "unavailable";

declare const codeModeActivityOwnerBrand: unique symbol;

export type CodeModeActivityOwner = Readonly<{
  [codeModeActivityOwnerBrand]: true;
}>;

export type CodeModeActivityContext = {
  readonly codeModeActivityOwner?: CodeModeActivityOwner;
};

type CodeModeRunActivity = {
  activeControls: number;
  unsettledBridgeEntries: number;
  parkedSnapshots: number;
};

const activityByOwner = new WeakMap<CodeModeActivityOwner, CodeModeRunActivity>();

export function createCodeModeActivityOwner(): CodeModeActivityOwner {
  return Object.freeze({}) as CodeModeActivityOwner;
}

function beginActivity(
  owner: CodeModeActivityOwner | undefined,
  field: keyof CodeModeRunActivity,
): () => void {
  if (!owner) {
    return () => {};
  }
  const activity = activityByOwner.get(owner);
  if (!activity) {
    return () => {};
  }
  activity[field] += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = activityByOwner.get(owner);
    if (current === activity) {
      current[field] = Math.max(0, current[field] - 1);
    }
  };
}

export function registerCodeModeRunActivity(owner: CodeModeActivityOwner | undefined): void {
  if (!owner || activityByOwner.has(owner)) {
    return;
  }
  activityByOwner.set(owner, {
    activeControls: 0,
    unsettledBridgeEntries: 0,
    parkedSnapshots: 0,
  });
}

export function beginCodeModeControlActivity(owner: CodeModeActivityOwner | undefined): () => void {
  return beginActivity(owner, "activeControls");
}

export function beginCodeModeBridgeActivity(owner: CodeModeActivityOwner | undefined): () => void {
  return beginActivity(owner, "unsettledBridgeEntries");
}

export function beginCodeModeSnapshotActivity(
  owner: CodeModeActivityOwner | undefined,
): () => void {
  return beginActivity(owner, "parkedSnapshots");
}

export function sampleCodeModeRunFinalQuiescence(
  owner: CodeModeActivityOwner | undefined,
): CodeModeRunFinalQuiescence {
  const activity = owner ? activityByOwner.get(owner) : undefined;
  if (!activity) {
    return "unavailable";
  }
  return activity.activeControls > 0 ||
    activity.unsettledBridgeEntries > 0 ||
    activity.parkedSnapshots > 0
    ? "non_quiescent"
    : "quiescent";
}

export function discardCodeModeRunActivity(owner: CodeModeActivityOwner | undefined): void {
  if (owner) {
    activityByOwner.delete(owner);
  }
}
