package com.recall.backend.telemetry;

import java.util.List;

import com.recall.backend.model.RecommendResponse;
import com.recall.backend.model.Recommendation;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * The production measurement path.
 *
 * <p>The failure mode these guard against is not a crash — it is a dashboard that reports a
 * number which sounds like accuracy but is not. Most of what follows is about the difference.
 */
class DecisionLogTest {

    private final DecisionLog log = new DecisionLog();

    private static RecommendResponse answered(String patchId, int confidence) {
        RecommendResponse r = new RecommendResponse();
        Recommendation rec = new Recommendation();
        rec.patchId = patchId;
        rec.confidence = confidence;
        r.recommendations = List.of(rec);
        return r;
    }

    private static RecommendResponse abstained(String code) {
        RecommendResponse r = new RecommendResponse();
        r.abstained = true;
        r.abstainCode = code;
        r.recommendations = List.of();
        return r;
    }

    private String decide(RecommendResponse response) {
        return log.record(response, 100, 25);
    }

    @Nested
    @DisplayName("linking outcomes to decisions")
    class Linking {

        @Test
        void everyDecisionGetsAnIdTheCallerCanReportAgainst() {
            String a = decide(answered("patch_a", 70));
            String b = decide(abstained("weak_evidence"));

            assertThat(a).isNotBlank();
            assertThat(b).isNotBlank().isNotEqualTo(a);
        }

        @Test
        void anOutcomeAttachesToItsDecision() {
            String id = decide(answered("patch_a", 70));

            assertThat(log.recordOutcome(id, "patch_a", false, "ticket-system")).isTrue();
            assertThat(log.snapshot().labelledDecisions).isEqualTo(1);
        }

        /** Labels arrive late; some arrive after the decision has aged out. That is not an error. */
        @Test
        void anOutcomeForAnUnknownDecisionIsReportedNotThrown() {
            assertThat(log.recordOutcome("no-such-decision", "patch_a", false, "ticket-system")).isFalse();
        }

        @Test
        void rejectsABlankDecisionId() {
            assertThatThrownBy(() -> log.recordOutcome("  ", "patch_a", false, "ticket-system"))
                .isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        void theWindowIsBoundedSoTheLogCannotGrowWithoutLimit() {
            for (int i = 0; i < DecisionLog.MAX_RECORDS + 500; i++) {
                decide(answered("patch_a", 70));
            }
            assertThat(log.size()).isEqualTo(DecisionLog.MAX_RECORDS);
        }
    }

    @Nested
    @DisplayName("accuracy")
    class Accuracy {

        @Test
        void precisionCountsOnlyDecisionsWhoseOutcomeIsKnown() {
            log.recordOutcome(decide(answered("patch_a", 70)), "patch_a", false, "ticket-system");
            log.recordOutcome(decide(answered("patch_b", 70)), "patch_other", false, "ticket-system");
            decide(answered("patch_c", 70)); // still unlabelled — must not count either way

            KpiReport kpi = log.snapshot();

            assertThat(kpi.answered).isEqualTo(3);
            assertThat(kpi.answeredAndLabelled).isEqualTo(2);
            assertThat(kpi.correct).isEqualTo(1);
            assertThat(kpi.answerPrecision).isCloseTo(0.5, within(1e-9));
        }

        /**
         * The circularity trap. If we suggest a fix, the engineer applies it because we said so,
         * and the ticket then records it, our "ground truth" is our own output echoed back.
         * Precision over those rows measures compliance, not accuracy.
         */
        @Test
        void independentPrecisionExcludesOutcomesWeOurselvesCaused() {
            // Three "correct" outcomes, but the engineer just did what we told them.
            for (int i = 0; i < 3; i++) {
                log.recordOutcome(decide(answered("patch_a", 90)), "patch_a", true, "engineer");
            }
            // One outcome reached independently, and we were wrong about it.
            log.recordOutcome(decide(answered("patch_a", 90)), "patch_different", false, "ticket-system");

            KpiReport kpi = log.snapshot();

            assertThat(kpi.answerPrecision)
                .as("headline precision is flattered by our own suggestions")
                .isCloseTo(0.75, within(1e-9));
            assertThat(kpi.independentlyLabelled).isEqualTo(1);
            assertThat(kpi.independentPrecision)
                .as("independent precision tells the truth")
                .isCloseTo(0.0, within(1e-9));
        }

        @Test
        void warnsWhenMostLabelsComeFromOurOwnSuggestions() {
            for (int i = 0; i < 10; i++) {
                log.recordOutcome(decide(answered("patch_a", 90)), "patch_a", true, "engineer");
            }

            assertThat(log.snapshot().caveats)
                .anyMatch(c -> c.contains("circular"));
        }

        @Test
        void calibrationBucketsStatedConfidenceAgainstObservedAccuracy() {
            log.recordOutcome(decide(answered("patch_a", 85)), "patch_a", false, "ticket-system");
            log.recordOutcome(decide(answered("patch_b", 82)), "patch_other", false, "ticket-system");
            log.recordOutcome(decide(answered("patch_c", 55)), "patch_c", false, "ticket-system");

            KpiReport kpi = log.snapshot();

            assertThat(kpi.calibration).containsKeys("80-89", "50-59");
            assertThat(kpi.calibration.get("80-89")[0]).isCloseTo(0.5, within(1e-9));
            assertThat(kpi.calibration.get("80-89")[1]).isEqualTo(2.0);
            assertThat(kpi.calibration.get("50-59")[0]).isCloseTo(1.0, within(1e-9));
        }
    }

    @Nested
    @DisplayName("abstentions and the capture loop")
    class Abstentions {

        @Test
        void breaksDownWhyItDeclined() {
            decide(abstained("weak_evidence"));
            decide(abstained("weak_evidence"));
            decide(abstained("no_similar_incident"));
            decide(answered("patch_a", 70));

            KpiReport kpi = log.snapshot();

            assertThat(kpi.abstentions).isEqualTo(3);
            assertThat(kpi.abstainRate).isCloseTo(0.75, within(1e-9));
            assertThat(kpi.abstainsByCode)
                .containsEntry("weak_evidence", 2)
                .containsEntry("no_similar_incident", 1);
        }

        /**
         * An abstain that teaches the system something is a success; one that teaches it nothing
         * is a dead end. This is the KPI for the capture loop, and it is a product metric, not a
         * model metric.
         */
        @Test
        void captureRateMeasuresWhetherAbstentionsProduceNewKnowledge() {
            log.recordOutcome(decide(abstained("no_similar_incident")), "patch_new", false, "engineer");
            log.recordOutcome(decide(abstained("no_similar_incident")), "", false, "engineer");
            decide(abstained("weak_evidence")); // never followed up at all

            KpiReport kpi = log.snapshot();

            assertThat(kpi.missedAnswers).as("one abstention yielded a reusable fix").isEqualTo(1);
            assertThat(kpi.captureRate).isCloseTo(1.0 / 3.0, within(1e-9));
        }

        @Test
        void warnsWhenAbstentionsAreNotTeachingTheSystemAnything() {
            for (int i = 0; i < 10; i++) {
                decide(abstained("no_similar_incident"));
            }

            assertThat(log.snapshot().caveats)
                .anyMatch(c -> c.contains("corpus is not learning"));
        }

        /**
         * We never find out what we would have said on a decision we declined, so the quality of
         * the abstain gate itself is unobservable in production. The dashboard must say so rather
         * than implying it is covered.
         */
        @Test
        void statesPlainlyThatAbstentionQualityIsNotMeasurableLive() {
            decide(abstained("weak_evidence"));

            assertThat(log.snapshot().caveats)
                .anyMatch(c -> c.contains("not directly measurable"));
        }
    }

    @Nested
    @DisplayName("honesty about sample size")
    class SampleSize {

        @Test
        void emptyLogReportsNothingRatherThanZeroes() {
            KpiReport kpi = log.snapshot();

            assertThat(kpi.decisions).isZero();
            assertThat(kpi.caveats).containsExactly("No decisions recorded yet.");
        }

        /** A precision of 1.00 over three labels is not a result, and must not read like one. */
        @Test
        void warnsWhenThePrecisionSampleIsTooThinToMeanAnything() {
            for (int i = 0; i < 3; i++) {
                log.recordOutcome(decide(answered("patch_a", 70)), "patch_a", false, "ticket-system");
            }

            KpiReport kpi = log.snapshot();

            assertThat(kpi.answerPrecision).isEqualTo(1.0);
            assertThat(kpi.caveats).anyMatch(c -> c.contains("indicative at best"));
        }

        /**
         * independentPrecision is the figure the caveats tell people to trust, so a thin sample
         * behind it has to be called out too — otherwise the advice just moves the problem.
         */
        @Test
        void warnsWhenTheNonCircularSampleIsThinEvenIfTheOverallOneIsNot() {
            // 40 circular labels (plenty overall) but only 5 independent ones.
            for (int i = 0; i < 40; i++) {
                log.recordOutcome(decide(answered("patch_a", 90)), "patch_a", true, "engineer");
            }
            for (int i = 0; i < 5; i++) {
                log.recordOutcome(decide(answered("patch_a", 90)), "patch_a", false, "ticket-system");
            }

            KpiReport kpi = log.snapshot();

            assertThat(kpi.answeredAndLabelled).isGreaterThanOrEqualTo(30);
            assertThat(kpi.caveats)
                .as("must not silently endorse independentPrecision over 5 rows")
                .anyMatch(c -> c.contains("non-circular labels"));
        }

        @Test
        void warnsWhenOutcomesAreKnownForOnlyAMinorityOfDecisions() {
            for (int i = 0; i < 20; i++) {
                decide(answered("patch_a", 70));
            }
            log.recordOutcome(decide(answered("patch_a", 70)), "patch_a", false, "ticket-system");

            assertThat(log.snapshot().caveats)
                .anyMatch(c -> c.contains("unlikely to be representative"));
        }
    }

    @Nested
    @DisplayName("system health")
    class Health {

        @Test
        void reportsLatencyPercentilesAndCorpusSize() {
            for (int i = 0; i < 100; i++) {
                RecommendResponse r = answered("patch_a", 70);
                log.record(r, 500 + i, i); // latency 0..99 ms
            }

            KpiReport kpi = log.snapshot();

            assertThat(kpi.latencyP50Ms).isBetween(45L, 55L);
            assertThat(kpi.latencyP95Ms).isBetween(90L, 99L);
            assertThat(kpi.medianCorpusSize).isBetween(540, 560);
        }

        @Test
        void reportsHowStaleTheAccuracyNumbersNecessarilyAre() {
            log.recordOutcome(decide(answered("patch_a", 70)), "patch_a", false, "ticket-system");

            assertThat(log.snapshot().medianTimeToLabelSeconds).isGreaterThanOrEqualTo(0);
        }
    }
}
