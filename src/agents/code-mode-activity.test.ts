import { describe, expect, it } from "vitest";
import {
  beginCodeModeBridgeActivity,
  beginCodeModeControlActivity,
  createCodeModeActivityOwner,
  discardCodeModeRunActivity,
  registerCodeModeRunActivity,
  sampleCodeModeRunFinalQuiescence,
} from "./code-mode-activity.js";

describe("Code Mode run activity", () => {
  it("reports unavailable when the command did not register an observer", () => {
    const owner = createCodeModeActivityOwner();

    expect(Object.isFrozen(owner)).toBe(true);
    expect(sampleCodeModeRunFinalQuiescence(owner)).toBe("unavailable");
  });

  it("isolates late releases by frozen owner identity", () => {
    const oldOwner = createCodeModeActivityOwner();
    const currentOwner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(oldOwner);
    const releaseOldBridge = beginCodeModeBridgeActivity(oldOwner);
    discardCodeModeRunActivity(oldOwner);

    registerCodeModeRunActivity(currentOwner);
    const releaseCurrentControl = beginCodeModeControlActivity(currentOwner);
    releaseOldBridge();
    expect(sampleCodeModeRunFinalQuiescence(currentOwner)).toBe("non_quiescent");

    releaseCurrentControl();
    expect(sampleCodeModeRunFinalQuiescence(currentOwner)).toBe("quiescent");
  });
});
