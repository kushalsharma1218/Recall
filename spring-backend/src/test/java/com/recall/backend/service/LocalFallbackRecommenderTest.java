package com.recall.backend.service;

import java.util.List;

import com.recall.backend.model.PatchRecord;
import com.recall.backend.model.QueryTicket;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.model.TicketRecord;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LocalFallbackRecommenderTest {

    private final LocalFallbackRecommender recommender = new LocalFallbackRecommender();

    @Test
    void recommendsPatchFromMostSimilarResolvedTickets() {
        RecommendRequest request = new RecommendRequest();
        request.query = new QueryTicket();
        request.query.title = "Production deadlock in SQL Server";
        request.query.description = "Error 1205 deadlock victim on order writes";
        request.query.severity = "high";
        request.query.system = "SQL Server";
        request.topK = 3;

        PatchRecord patch1 = new PatchRecord();
        patch1.id = "patch_deadlock";
        patch1.name = "Deadlock Retry";

        PatchRecord patch2 = new PatchRecord();
        patch2.id = "patch_timeout";
        patch2.name = "Timeout Increase";

        request.patches = List.of(patch1, patch2);

        TicketRecord t1 = new TicketRecord();
        t1.id = "T-1";
        t1.title = "SQL deadlock in checkout";
        t1.description = "Deadlock error 1205 during checkout transaction";
        t1.severity = "high";
        t1.system = "SQL Server";
        t1.resolvedPatch = "patch_deadlock";
        t1.resolutionDescription = "Added retry with backoff around transaction";

        TicketRecord t2 = new TicketRecord();
        t2.id = "T-2";
        t2.title = "API request timeout";
        t2.description = "Gateway timeout on reporting endpoint";
        t2.severity = "medium";
        t2.system = "PostgreSQL";
        t2.resolvedPatch = "patch_timeout";
        t2.resolutionDescription = "Increased timeout and tuned index";

        request.localCorpus = List.of(t1, t2);

        RecommendResponse response = recommender.recommend(request);

        assertThat(response.abstained).isFalse();
        assertThat(response.recommendations).isNotEmpty();
        assertThat(response.recommendations.get(0).patchId).isEqualTo("patch_deadlock");
        assertThat(response.similarIncidents).isNotEmpty();
    }

    @Test
    void abstainsWhenNoMappedPatchEvidenceExists() {
        RecommendRequest request = new RecommendRequest();
        request.query = new QueryTicket();
        request.query.title = "Replication lag";
        request.query.description = "Secondary replica is 30 minutes behind";

        PatchRecord patch = new PatchRecord();
        patch.id = "patch_replication";
        request.patches = List.of(patch);

        TicketRecord ticket = new TicketRecord();
        ticket.id = "T-3";
        ticket.title = "Random issue";
        ticket.description = "No useful details";
        ticket.resolvedPatch = "unknown_patch";

        request.localCorpus = List.of(ticket);

        RecommendResponse response = recommender.recommend(request);

        assertThat(response.abstained).isTrue();
        assertThat(response.recommendations).isEmpty();
    }
}
