package com.recall.backend.eval;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** One historical incident in a backtest dataset, with the fix that was actually applied. */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BacktestCase {
    public String id = "";
    public String title = "";
    public String description = "";
    public String system = "";
    public String severity = "";
    public String resolvedPatch = "";
    public String resolutionDescription = "";
    public String changedDate;
    public String source = "";

    /** A ticket closed without a recorded fix cannot be scored, but still belongs in the corpus. */
    public boolean hasGroundTruth() {
        return resolvedPatch != null && !resolvedPatch.isBlank();
    }
}
