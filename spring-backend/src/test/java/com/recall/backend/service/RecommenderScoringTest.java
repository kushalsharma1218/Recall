package com.recall.backend.service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.model.TicketRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import static com.recall.backend.support.Tickets.patch;
import static com.recall.backend.support.Tickets.request;
import static com.recall.backend.support.Tickets.ticket;
import static com.recall.backend.support.Tickets.withChangedDate;
import static com.recall.backend.support.Tickets.withSeverity;
import static com.recall.backend.support.Tickets.withSystem;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;
import static org.assertj.core.api.Assertions.withinPercentage;

/**
 * Regression coverage for the ranking and abstain defects fixed alongside these tests.
 *
 * <p>Each nested class documents the behaviour that was wrong and pins the corrected behaviour.
 */
class RecommenderScoringTest {

    private final LocalFallbackRecommender recommender = new LocalFallbackRecommender();

    @SuppressWarnings("unchecked")
    private static double featureOf(RecommendResponse response, String ticketId, String feature) {
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) response.debug.get("top_candidates");
        assertThat(candidates).as("debug.top_candidates").isNotNull();
        return candidates.stream()
            .filter(c -> ticketId.equals(c.get("ticket_id")))
            .findFirst()
            .map(c -> ((Map<String, Double>) c.get("features")).get(feature))
            .orElseThrow(() -> new AssertionError("no candidate " + ticketId + " in debug output"));
    }

    private static double scoreOf(RecommendResponse response, String ticketId) {
        return featureOf(response, ticketId, "combined");
    }

    @Nested
    @DisplayName("abstains instead of guessing")
    class AbstainBehaviour {

        /**
         * BM25 used to be normalised against the best-scoring row in the same request, so the
         * least-bad row always scored a perfect 1.0 however irrelevant it was. That put the top
         * score far above the absolute abstain threshold, and the engine confidently recommended
         * a database fix for an unrelated incident.
         */
        @Test
        void abstainsWhenNothingInTheCorpusResemblesTheQuery() {
            RecommendRequest req = request(
                "Kubernetes pod eviction storm on node drain",
                "Ingress controller pods evicted repeatedly during a rolling node drain",
                List.of(ticket("T-1", "SQL deadlock in checkout", "Deadlock error 1205 on order writes", "patch_deadlock"))
            );

            RecommendResponse response = recommender.recommend(req);

            assertThat(response.abstained).isTrue();
            assertThat(response.recommendations).isEmpty();
            assertThat(response.abstainCode).isEqualTo("no_similar_incident");
            assertThat(response.needsResolutionInput)
                .as("an unmatched incident should prompt the engineer for a fix")
                .isTrue();
        }

        /**
         * The dangerous shape in production: several loosely related past tickets that all ended
         * in the same fix. Support boosts confidence past the threshold and, because there is only
         * one candidate patch, the ambiguity gate never fires — so the absolute score gate is the
         * only thing standing between the user and a confident wrong answer.
         *
         * <p>With BM25 normalised against the best row in the batch, this recommended a SQL
         * deadlock patch for a Kubernetes incident on the strength of the shared words "restart"
         * and "load".
         */
        @Test
        void abstainsWhenOnlyIncidentalWordsAreShared() {
            RecommendRequest req = request(
                "Kubernetes ingress pods restart repeatedly under load",
                "Ingress controller pods restart in a loop during a node drain under heavy load",
                List.of(
                    ticket("T-1", "SQL deadlock during checkout", "Deadlock 1205; a restart under load cleared it", "patch_deadlock"),
                    ticket("T-2", "Order writes blocked", "Blocking chain under load, restart of the writer helped", "patch_deadlock"),
                    ticket("T-3", "Checkout latency spike", "Heavy load caused a restart of the pool", "patch_deadlock")
                )
            );

            RecommendResponse response = recommender.recommend(req);

            assertThat(response.abstained).isTrue();
            assertThat(response.abstainCode).isEqualTo("weak_evidence");
            assertThat(response.recommendations).isEmpty();
            assertThat(response.needsResolutionInput).isTrue();
        }

        /** A close textual match must still be recommended — the gate must not abstain on everything. */
        @Test
        void recommendsWhenTheCorpusGenuinelyMatches() {
            RecommendRequest req = request(
                "SQL deadlock in checkout",
                "Deadlock error 1205 hitting order writes under load",
                List.of(
                    ticket("T-1", "SQL deadlock during checkout writes", "Deadlock victim error 1205 on the orders table", "patch_deadlock"),
                    ticket("T-2", "Login failures for reporting user", "Login failed error 18456 from the reporting host", "patch_login")
                )
            );

            RecommendResponse response = recommender.recommend(req);

            assertThat(response.abstained).isFalse();
            assertThat(response.abstainCode).isNull();
            assertThat(response.needsResolutionInput).isFalse();
            assertThat(response.recommendations.get(0).patchId).isEqualTo("patch_deadlock");
        }

        /**
         * Two equally good candidate fixes is exactly the case where the product must ask a human
         * rather than pick one. The phantom severity signal used to manufacture a margin here and
         * turn a genuine tie into a confident (arbitrary) recommendation.
         */
        @Test
        void abstainsWhenTwoPastFixesMatchEquallyWell() {
            String title = "SQL deadlock in checkout";
            String description = "Deadlock error 1205 on order writes under load";

            RecommendRequest req = request(title, description, List.of(
                withSeverity(ticket("T-critical", title, description, "patch_retry"), "critical"),
                withSeverity(ticket("T-medium", title, description, "patch_isolation"), "medium")
            ));

            RecommendResponse response = recommender.recommend(req);

            assertThat(response.abstained).isTrue();
            assertThat(response.abstainCode).isEqualTo("ambiguous_evidence");
            assertThat(response.recommendations).isEmpty();
            assertThat(response.needsResolutionInput).isTrue();
        }

        @Test
        void abstainsWithEmptyCorpusCodeWhenThereIsNothingToLearnFrom() {
            RecommendResponse response = recommender.recommend(request("Deadlock", "1205", List.of()));

            assertThat(response.abstained).isTrue();
            assertThat(response.abstainCode).isEqualTo("empty_corpus");
            assertThat(response.needsResolutionInput).isTrue();
        }

        /** A too-thin query is a bad request, not a gap in the corpus — do not ask for a fix. */
        @Test
        void abstainsWithEmptyQueryCodeAndDoesNotAskForAResolution() {
            RecommendResponse response = recommender.recommend(
                request("", "", List.of(ticket("T-1", "SQL deadlock", "error 1205", "patch_deadlock")))
            );

            assertThat(response.abstained).isTrue();
            assertThat(response.abstainCode).isEqualTo("empty_query");
            assertThat(response.needsResolutionInput)
                .as("the request is what needs fixing here, not the corpus")
                .isFalse();
        }

        /** Similar incidents stay visible while abstaining, so the engineer keeps the context. */
        @Test
        void keepsSimilarIncidentsVisibleWhenAbstaining() {
            String title = "SQL deadlock in checkout";
            String description = "Deadlock error 1205 on order writes under load";

            RecommendResponse response = recommender.recommend(request(title, description, List.of(
                withSeverity(ticket("T-critical", title, description, "patch_retry"), "critical"),
                withSeverity(ticket("T-medium", title, description, "patch_isolation"), "medium")
            )));

            assertThat(response.abstained).isTrue();
            assertThat(response.similarIncidents).isNotEmpty();
        }
    }

    @Nested
    @DisplayName("corroborating evidence never lowers confidence")
    class SupportHandling {

        /**
         * Confidence was computed from the mean similarity across every ticket supporting a fix,
         * so a weakly related third ticket that used the *same* fix dragged the mean down and
         * could tip a correct recommendation into an abstain. More agreement must never subtract.
         */
        @Test
        void aWeakThirdTicketSupportingTheSameFixDoesNotCauseAnAbstain() {
            List<TicketRecord> strongPair = List.of(
                ticket("T-1", "SQL deadlock during checkout", "Deadlock 1205; a restart under load cleared it", "patch_deadlock"),
                ticket("T-2", "Order writes blocked", "Blocking chain under load, restart of the writer helped", "patch_deadlock")
            );
            List<TicketRecord> withWeakExtra = new java.util.ArrayList<>(strongPair);
            withWeakExtra.add(ticket("T-3", "Checkout latency spike", "Heavy load caused a restart of the pool", "patch_deadlock"));

            String title = "SQL deadlock during checkout writes";
            String description = "Deadlock 1205 blocking chain on the orders table under load";

            RecommendResponse withoutExtra = recommender.recommend(request(title, description, strongPair));
            RecommendResponse withExtra = recommender.recommend(request(title, description, withWeakExtra));

            assertThat(withoutExtra.abstained).as("baseline: the strong pair alone is recommendable").isFalse();
            assertThat(withExtra.abstained).as("adding agreeing evidence must not cause an abstain").isFalse();
            assertThat(withExtra.recommendations.get(0).confidence)
                .isGreaterThanOrEqualTo(withoutExtra.recommendations.get(0).confidence);
        }
    }

    @Nested
    @DisplayName("severity is only scored when it was actually supplied")
    class SeverityHandling {

        /**
         * {@code severity} defaulted to "medium" on both the query and the corpus model, and blank
         * values normalised to "medium" too, so every request scored a severity nobody entered.
         */
        @Test
        void aQueryWithoutSeverityDoesNotFavourMediumTickets() {
            String title = "Replica redo queue growing on the secondary";
            String description = "Replication sync failure with a growing redo queue";

            RecommendRequest req = request(title, description, List.of(
                withSeverity(ticket("T-critical", title, description, "patch_a"), "critical"),
                withSeverity(ticket("T-medium", title, description, "patch_b"), "medium")
            ));
            assertThat(req.query.severity).as("query severity is unset by default").isEmpty();

            RecommendResponse response = recommender.recommend(req);

            // Tolerance covers rank-fusion tie noise (~0.1%). The phantom severity signal this
            // guards against separated identical tickets by ~17%.
            assertThat(scoreOf(response, "T-critical"))
                .as("identical tickets must not be separated by a severity the user never entered")
                .isCloseTo(scoreOf(response, "T-medium"), withinPercentage(2));
        }

        /** When the user does supply a severity, agreement should still count. */
        @Test
        void anExplicitSeverityStillBoostsMatchingTickets() {
            String title = "Replica redo queue growing on the secondary";
            String description = "Replication sync failure with a growing redo queue";

            RecommendRequest req = request(title, description, List.of(
                withSeverity(ticket("T-critical", title, description, "patch_a"), "critical"),
                withSeverity(ticket("T-medium", title, description, "patch_b"), "medium")
            ));
            req.query.severity = "critical";

            RecommendResponse response = recommender.recommend(req);

            assertThat(scoreOf(response, "T-critical")).isGreaterThan(scoreOf(response, "T-medium"));
        }

        /** A ticket with no severity must not be treated as agreeing with an explicit query severity. */
        @Test
        void aTicketWithoutSeverityIsNotCountedAsAMatch() {
            String title = "Replica redo queue growing on the secondary";
            String description = "Replication sync failure with a growing redo queue";

            RecommendRequest req = request(title, description, List.of(
                withSeverity(ticket("T-declared", title, description, "patch_a"), "high"),
                ticket("T-unset", title, description, "patch_b")
            ));
            req.query.severity = "high";

            RecommendResponse response = recommender.recommend(req);

            assertThat(scoreOf(response, "T-declared")).isGreaterThan(scoreOf(response, "T-unset"));
        }
    }

    @Nested
    @DisplayName("recency nudges ranking without dominating it")
    class RecencyHandling {

        private static String daysAgo(long days) {
            return Instant.now().minus(days, ChronoUnit.DAYS).toString();
        }

        /**
         * The recency multiplier was unbounded below, and an absent timestamp was reported as ten
         * years old. Two identical tickets differing only in whether a date was present scored
         * 1.158 vs 0.666 — a 42% penalty for missing metadata.
         */
        @Test
        void aMissingChangedDateDoesNotBuryAnOtherwiseIdenticalTicket() {
            String title = "SQL deadlock in checkout";
            String description = "Deadlock error 1205 on order writes";

            RecommendResponse response = recommender.recommend(request(title, description, List.of(
                withChangedDate(ticket("T-dated", title, description, "patch_a"), daysAgo(10)),
                ticket("T-undated", title, description, "patch_b")
            )));

            double dated = scoreOf(response, "T-dated");
            double undated = scoreOf(response, "T-undated");
            assertThat(undated / dated)
                .as("an unknown timestamp is unknown, not ancient")
                .isGreaterThan(0.9);
        }

        /** Azure sends offset timestamps, but imports routinely carry a bare date or local date-time. */
        @Test
        void parsesBareDateAndLocalDateTimeTimestamps() {
            String title = "SQL deadlock in checkout";
            String description = "Deadlock error 1205 on order writes";
            String recentDate = Instant.now().minus(5, ChronoUnit.DAYS).toString().substring(0, 10);

            RecommendResponse response = recommender.recommend(request(title, description, List.of(
                withChangedDate(ticket("T-offset", title, description, "patch_a"), daysAgo(5)),
                withChangedDate(ticket("T-bare", title, description, "patch_b"), recentDate),
                withChangedDate(ticket("T-local", title, description, "patch_c"), recentDate + "T09:30:00")
            )));

            double offset = featureOf(response, "T-offset", "recency");
            assertThat(featureOf(response, "T-bare", "recency")).isCloseTo(offset, within(1e-9));
            assertThat(featureOf(response, "T-local", "recency")).isCloseTo(offset, within(1e-9));
        }

        /** An old exact match is more useful than a recent unrelated one. */
        @Test
        void ageNeverOutweighsRelevance() {
            RecommendResponse response = recommender.recommend(request(
                "SQL deadlock in checkout",
                "Deadlock error 1205 on order writes",
                List.of(
                    withChangedDate(ticket("T-old-match", "SQL deadlock in checkout", "Deadlock error 1205 on order writes", "patch_a"), daysAgo(2000)),
                    withChangedDate(ticket("T-new-noise", "Certificate rotation runbook", "Rotate the ingress TLS certificate", "patch_b"), daysAgo(1))
                )
            ));

            assertThat(response.abstained).isFalse();
            assertThat(response.recommendations.get(0).patchId).isEqualTo("patch_a");
        }

        @Test
        void anUnparseableTimestampIsTreatedAsUnknownRatherThanAncient() {
            String title = "SQL deadlock in checkout";
            String description = "Deadlock error 1205 on order writes";

            RecommendResponse response = recommender.recommend(request(title, description, List.of(
                withChangedDate(ticket("T-garbage", title, description, "patch_a"), "not-a-date"),
                ticket("T-absent", title, description, "patch_b")
            )));

            assertThat(featureOf(response, "T-garbage", "recency"))
                .isCloseTo(featureOf(response, "T-absent", "recency"), within(1e-9));
        }
    }

    @Nested
    @DisplayName("rank fusion only rewards documents that matched")
    class RankFusion {

        /**
         * Reciprocal-rank fusion was applied to a single ranked list fused with itself, which
         * handed rank credit to every document including ones that matched nothing at all.
         */
        @Test
        void aDocumentMatchingNothingScoresZero() {
            RecommendResponse response = recommender.recommend(request(
                "SQL deadlock in checkout",
                "Deadlock error 1205 on order writes",
                List.of(
                    ticket("T-match", "SQL deadlock in checkout", "Deadlock error 1205 on order writes", "patch_a"),
                    ticket("T-unrelated", "Quarterly capacity planning review", "Forecast headroom for the next quarter", "patch_b")
                )
            ));

            assertThat(scoreOf(response, "T-unrelated"))
                .as("no shared signal should mean no score")
                .isEqualTo(0.0);
            assertThat(response.similarIncidents)
                .extracting(s -> s.ticketId)
                .doesNotContain("T-unrelated");
        }
    }

    @Nested
    @DisplayName("patch filtering")
    class PatchFiltering {

        @Test
        void ignoresResolvedPatchesThatAreNotInTheSuppliedCatalogue() {
            RecommendRequest req = request(
                "SQL deadlock in checkout",
                "Deadlock error 1205 on order writes",
                List.of(ticket("T-1", "SQL deadlock in checkout", "Deadlock error 1205 on order writes", "patch_retired"))
            );
            req.patches = List.of(patch("patch_deadlock"));

            RecommendResponse response = recommender.recommend(req);

            assertThat(response.abstained).isTrue();
            assertThat(response.abstainCode).isEqualTo("no_patch_evidence");
            assertThat(response.needsResolutionInput).isTrue();
        }

        @Test
        void skipsCorpusEntriesWithNoRecordedFix() {
            TicketRecord unresolved = ticket("T-open", "SQL deadlock in checkout", "Deadlock error 1205 on order writes", null);
            unresolved.resolvedPatch = null;

            RecommendResponse response = recommender.recommend(request(
                "SQL deadlock in checkout",
                "Deadlock error 1205 on order writes",
                List.of(unresolved)
            ));

            assertThat(response.abstained).isTrue();
            assertThat(response.abstainCode).isEqualTo("no_patch_evidence");
        }
    }

    @Nested
    @DisplayName("system matching")
    class SystemHandling {

        @Test
        void prefersTicketsFromTheSameSystem() {
            String title = "Connection pool exhausted under load";
            String description = "Requests queue waiting for a free connection";

            RecommendRequest req = request(title, description, List.of(
                withSystem(ticket("T-same", title, description, "patch_a"), "PostgreSQL"),
                withSystem(ticket("T-other", title, description, "patch_b"), "Cosmos DB")
            ));
            req.query.system = "PostgreSQL";

            RecommendResponse response = recommender.recommend(req);

            assertThat(scoreOf(response, "T-same")).isGreaterThan(scoreOf(response, "T-other"));
        }
    }

    @Nested
    @DisplayName("feedback")
    class Feedback {

        @Test
        void countsUpAndDownVotesPerPatch() {
            recommender.recordFeedback("patch_a", "up");
            recommender.recordFeedback("patch_a", "UP");
            var result = recommender.recordFeedback("patch_a", "down");

            assertThat(result.patchId).isEqualTo("patch_a");
            assertThat(result.positive).isEqualTo(2);
            assertThat(result.negative).isEqualTo(1);
        }

        @Test
        void rejectsBlankPatchIdsAndUnknownVotes() {
            assertThatThrownBy(() -> recommender.recordFeedback("  ", "up"))
                .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> recommender.recordFeedback("patch_a", "maybe"))
                .isInstanceOf(IllegalArgumentException.class);
        }

        /** Patch ids come from the client, so the counter map must not grow without bound. */
        @Test
        void rejectsOversizedPatchIds() {
            assertThatThrownBy(() -> recommender.recordFeedback("p".repeat(500), "up"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("at most");
        }

        @Test
        void upvotesRaiseAPatchAboveAnEquallyMatchedDownvotedOne() {
            String title = "Replica redo queue growing on the secondary";
            String description = "Replication sync failure with a growing redo queue";

            for (int i = 0; i < 8; i++) {
                recommender.recordFeedback("patch_good", "up");
                recommender.recordFeedback("patch_bad", "down");
            }

            RecommendResponse response = recommender.recommend(request(title, description, List.of(
                ticket("T-good", title, description, "patch_good"),
                ticket("T-bad", title, description, "patch_bad")
            )));

            assertThat(response.abstained).isFalse();
            assertThat(response.recommendations.get(0).patchId).isEqualTo("patch_good");
        }
    }

    @Nested
    @DisplayName("health")
    class Health {

        /** {@code tickets_loaded: 0} was hardcoded and read as a failed corpus load. */
        @Test
        void reportsThatTheCorpusArrivesPerRequest() {
            Map<String, Object> health = recommender.health();

            assertThat(health).doesNotContainKey("tickets_loaded");
            assertThat(health.get("corpus_source")).isEqualTo("request");
            assertThat(health.get("engine")).isEqualTo("spring-local-hybrid");
        }
    }
}
