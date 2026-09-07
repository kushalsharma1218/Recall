package com.recall.backend.support;

import java.util.List;

import com.recall.backend.model.PatchRecord;
import com.recall.backend.model.QueryTicket;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.TicketRecord;

/** Small builders so the scoring tests read as scenarios rather than field assignments. */
public final class Tickets {

    private Tickets() {
    }

    public static TicketRecord ticket(String id, String title, String description, String patchId) {
        TicketRecord t = new TicketRecord();
        t.id = id;
        t.title = title;
        t.description = description;
        t.resolvedPatch = patchId;
        t.resolutionDescription = "Applied " + patchId;
        return t;
    }

    public static TicketRecord withSeverity(TicketRecord t, String severity) {
        t.severity = severity;
        return t;
    }

    public static TicketRecord withSystem(TicketRecord t, String system) {
        t.system = system;
        return t;
    }

    public static TicketRecord withChangedDate(TicketRecord t, String changedDate) {
        t.changedDate = changedDate;
        return t;
    }

    public static PatchRecord patch(String id) {
        PatchRecord p = new PatchRecord();
        p.id = id;
        p.name = id;
        return p;
    }

    public static RecommendRequest request(String title, String description, List<TicketRecord> corpus) {
        RecommendRequest r = new RecommendRequest();
        r.query = new QueryTicket();
        r.query.title = title;
        r.query.description = description;
        r.localCorpus = corpus;
        r.debug = true;
        return r;
    }
}
