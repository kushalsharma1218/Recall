package com.recall.backend.eval;

import java.util.List;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The accuracy gate.
 *
 * <p>Unit tests pin behaviour on cases someone thought of. This pins behaviour in aggregate over a
 * replayed history, which is what catches a change that fixes one scenario and quietly degrades
 * twenty others.
 *
 * <p>The thresholds are a ratchet, not a target: raise them as the engine improves, and treat a
 * failure as "explain the regression", not "lower the bar". Numbers here come from the bundled
 * synthetic dataset and are only meaningful relative to themselves — point the harness at a real
 * export with {@code -Drecall.backtest.dataset=...} before reading anything into the absolutes.
 */
class BacktestTest {

    private static BacktestReport report;

    @BeforeAll
    static void runBacktest() {
        BacktestRunner runner = new BacktestRunner();
        List<BacktestCase> dataset = runner.loadDataset();
        report = runner.run(dataset);
        System.out.println(report.format());
    }

    @Test
    @DisplayName("the dataset is substantial enough for the metrics to mean anything")
    void datasetIsUsable() {
        assertThat(report.total()).isGreaterThanOrEqualTo(30);
        assertThat(report.answerable()).isGreaterThan(0);
        assertThat(report.unanswerable())
            .as("without unprecedented incidents there is nothing testing the abstain path")
            .isGreaterThan(0);
    }

    /**
     * The product bar. A wrong fix mid-incident costs more than no fix, so this is the number that
     * must not regress — ahead of coverage, recall, or MRR.
     *
     * <p>Baseline 0.893 on the bundled dataset; gated slightly below to absorb noise.
     */
    @Test
    @DisplayName("answer precision: of the fixes proposed, how many were right")
    void answerPrecisionDoesNotRegress() {
        assertThat(report.answerPrecision())
            .as("answer precision %.3f — a wrong fix costs more than no fix", report.answerPrecision())
            .isGreaterThanOrEqualTo(0.85);
    }

    /**
     * Recommending a fix for an incident whose real fix was never recorded is the worst failure
     * mode, and the target is zero.
     *
     * <p>It is not zero today, and the gate is deliberately set at the observed baseline rather
     * than at the target so the number stays visible instead of being silently skipped. The
     * residual cases are structural: where the corpus is *unanimous but incomplete* — every past
     * incident with these symptoms used fix A, and this one needed fix B that nobody has recorded
     * yet — there is no lexical signal that distinguishes them, and no threshold can recover it.
     * Closing this needs evidence the text does not carry (the code diff, the root cause) or a
     * reasoning step that can argue the negative case. Tighten this gate when that lands.
     */
    @Test
    @DisplayName("does not invent fixes for unprecedented incidents more often than baseline")
    void hallucinationRateDoesNotRegress() {
        assertThat(report.hallucinationRate())
            .as("hallucination rate %.3f — target is 0.0, see javadoc", report.hallucinationRate())
            .isLessThanOrEqualTo(0.16);
    }

    /** Precision is worthless if bought by abstaining on everything. */
    @Test
    @DisplayName("still answers often enough to be useful")
    void coverageIsNotTraded() {
        assertThat(report.answerableRecall())
            .as("answerable recall %.3f — precision must not be bought with silence",
                report.answerableRecall())
            .isGreaterThanOrEqualTo(0.65);
    }

    @Test
    @DisplayName("ranking quality does not regress")
    void rankingQualityHolds() {
        assertThat(report.recallAt(3)).isGreaterThanOrEqualTo(report.answerableRecall());
        assertThat(report.meanReciprocalRank()).isGreaterThanOrEqualTo(0.65);
    }
}
