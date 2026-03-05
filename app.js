// ============================================================
// app.js — Azure Ticket Database Patch Resolver
// 100% Offline — Pure JavaScript NLP + Recommendation Engine
// ============================================================

'use strict';

// ─────────────────────────────────────────
//  1. STOPWORDS & TOKENIZER
// ─────────────────────────────────────────
const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
    'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they', 'he', 'she',
    'from', 'into', 'about', 'after', 'before', 'between', 'during', 'through', 'not',
    'no', 'yes', 'also', 'as', 'if', 'when', 'while', 'then', 'than', 'so', 'too', 'very',
    'just', 'more', 'most', 'all', 'some', 'any', 'each', 'our', 'your', 'their', 'my',
    'getting', 'getting', 'causing', 'found', 'after', 'error', 'errors', 'issue', 'issues',
    'problem', 'problems', 'ticket', 'azure', 'database', 'db', 'sql'
]);

const NLP_PHRASE_NORMALIZERS = [
    [/\bdead[\s-]?locks?\b/g, 'deadlock'],
    [/\btime[\s-]?outs?\b/g, 'timeout'],
    [/\bout[\s-]?of[\s-]?memory\b/g, 'oom'],
    [/\btoo many requests\b/g, '429'],
    [/\bavailability[\s-]?groups?\b/g, 'alwayson'],
    [/\balways[\s-]?on\b/g, 'alwayson'],
    [/\bmanaged[\s-]?instance\b/g, 'managedinstance'],
    [/\belastic[\s-]?pool\b/g, 'elasticpool'],
    [/\bquery[\s-]?plan\b/g, 'queryplan'],
    [/\bindex[\s-]?scan\b/g, 'indexscan'],
    [/\bindex[\s-]?seek\b/g, 'indexseek']
];

const NLP_TOKEN_CANONICAL = {
    deadlocks: 'deadlock',
    timeout: 'timeout',
    timeouts: 'timeout',
    timedout: 'timeout',
    throttled: 'throttle',
    throttling: 'throttle',
    retries: 'retry',
    retried: 'retry',
    failover: 'failover',
    failovers: 'failover',
    lockwait: 'lockwait',
    lockwaits: 'lockwait',
    blocking: 'block',
    blocked: 'block',
    contention: 'contend',
    contentions: 'contend',
    memorypressure: 'oom',
    outofmemory: 'oom',
    postgres: 'postgresql',
    pg: 'postgresql',
    cosmosdb: 'cosmos'
};

function normalizeTextForNlp(text) {
    let out = String(text || '').toLowerCase();
    NLP_PHRASE_NORMALIZERS.forEach(([rx, repl]) => {
        out = out.replace(rx, ` ${repl} `);
    });
    return out;
}

function normalizeToken(token) {
    let t = String(token || '').toLowerCase().trim();
    if (!t) return '';
    if (/^\d{3,5}$/.test(t)) return `code_${t}`;
    t = NLP_TOKEN_CANONICAL[t] || t;

    // Very light stemming keeps related forms aligned without over-compressing terms.
    if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
    else if (t.endsWith('ing') && t.length > 5) t = t.slice(0, -3);
    else if (t.endsWith('ed') && t.length > 4) t = t.slice(0, -2);
    else if (t.endsWith('s') && t.length > 3 && !t.endsWith('ss')) t = t.slice(0, -1);

    return NLP_TOKEN_CANONICAL[t] || t;
}

function tokenize(text) {
    return normalizeTextForNlp(text)
        .replace(/[^a-z0-9_\s'-]/g, ' ')
        .split(/\s+/)
        .map(normalizeToken)
        .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function repeatTokens(tokens, weight) {
    const n = Math.max(1, Math.round(weight));
    const out = [];
    for (let i = 0; i < n; i++) out.push(...tokens);
    return out;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeSeverityValue(severity) {
    const s = String(severity || '').toLowerCase().trim();
    if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
    return '';
}

function normalizeSystemValue(system) {
    const s = normalizeTextForNlp(system);
    if (!s.trim()) return '';
    if (s.includes('cosmos')) return 'cosmos';
    if (s.includes('postgres')) return 'postgresql';
    if (s.includes('mysql')) return 'mysql';
    if (s.includes('mariadb')) return 'mariadb';
    if (s.includes('managedinstance')) return 'sql-managed-instance';
    if (s.includes('serverless')) return 'sql-serverless';
    if (s.includes('elasticpool')) return 'sql-elastic-pool';
    if (s.includes('alwayson') || s.includes('availability group')) return 'sql-alwayson';
    if (s.includes('azure sql')) return 'azure-sql';
    if (s.includes('sql server')) return 'sql-server';
    return tokenize(s).slice(0, 2).join('-');
}

function normalizeTagArray(tags) {
    const arr = Array.isArray(tags)
        ? tags
        : String(tags || '').split(/[;,]/g);
    const seen = new Set();
    const out = [];
    arr.forEach(tag => {
        const canonical = normalizeToken(String(tag || '').trim().toLowerCase());
        if (!canonical || canonical.length < 2 || seen.has(canonical)) return;
        seen.add(canonical);
        out.push(canonical);
    });
    return out;
}

function normalizeTicketForModel(rawTicket) {
    const ticket = { ...(rawTicket || {}) };
    const title = String(ticket.title || '').trim();
    const description = String(ticket.description || ticket.desc || '').trim();
    const severity = normalizeSeverityValue(ticket.severity) || 'medium';
    const tags = normalizeTagArray(ticket.tags);
    const system = String(ticket.system || '').trim();
    const resolvedPatch = ticket.resolvedPatch ? String(ticket.resolvedPatch).trim() : '';
    const resolutionDescription = String(ticket.resolutionDescription || ticket.resolution || '').trim();

    return {
        ...ticket,
        title,
        description,
        desc: description,
        severity,
        tags,
        system,
        resolvedPatch,
        resolutionDescription,
        outcome: ticket.outcome || (ticket.status === 'resolved' ? 'resolved' : ticket.outcome),
        status: ticket.status || (ticket.outcome === 'resolved' ? 'resolved' : ticket.status)
    };
}

function ticketContentSignature(ticket) {
    const modelTicket = normalizeTicketForModel(ticket);
    const base = `${normalizeTextForNlp(modelTicket.title).slice(0, 220)}|${normalizeTextForNlp(modelTicket.description).slice(0, 420)}|${normalizeSystemValue(modelTicket.system)}|${modelTicket.severity}|${modelTicket.resolvedPatch}`;
    return base.replace(/\s+/g, ' ').trim();
}

function lexicalOverlap(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let shared = 0;
    setA.forEach(t => { if (setB.has(t)) shared++; });
    return shared === 0 ? 0 : shared / Math.sqrt(setA.size * setB.size);
}

function buildIDF(tokenDocs) {
    const total = tokenDocs.length;
    if (!total) return {};
    const df = {};
    tokenDocs.forEach(doc => {
        const uniq = new Set(doc || []);
        uniq.forEach(t => { df[t] = (df[t] || 0) + 1; });
    });
    const idf = {};
    Object.keys(df).forEach(t => {
        idf[t] = Math.log((total + 1) / (df[t] + 1)) + 1;
    });
    return idf;
}

function buildTermFrequency(tokens) {
    const tf = {};
    (tokens || []).forEach(t => { tf[t] = (tf[t] || 0) + 1; });
    return tf;
}

function bm25Score(queryTokens, docTf, docLen, docFreq, totalDocs, avgDocLen, k1 = 1.5, b = 0.75) {
    if (!queryTokens?.length || !docLen || !totalDocs) return 0;
    let score = 0;
    const uniqueQuery = new Set(queryTokens);
    uniqueQuery.forEach(term => {
        const tf = docTf[term] || 0;
        if (!tf) return;
        const df = docFreq[term] || 0;
        const idf = Math.log(1 + ((totalDocs - df + 0.5) / (df + 0.5)));
        const denom = tf + k1 * (1 - b + b * (docLen / (avgDocLen || 1)));
        score += idf * ((tf * (k1 + 1)) / denom);
    });
    return score;
}

// ─────────────────────────────────────────
//  2. TF VECTOR & COSINE SIMILARITY
// ─────────────────────────────────────────
function buildTFVector(tokens, idfMap = null) {
    const vec = {};
    tokens.forEach(t => { vec[t] = (vec[t] || 0) + 1; });
    const len = tokens.length || 1;
    Object.keys(vec).forEach(k => {
        vec[k] /= len;
        if (idfMap) vec[k] *= (idfMap[k] || 1);
    });
    return vec;
}

function cosineSimilarity(vecA, vecB) {
    const keysA = Object.keys(vecA);
    if (!keysA.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    const allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
    allKeys.forEach(k => {
        const a = vecA[k] || 0;
        const b = vecB[k] || 0;
        dot += a * b;
        magA += a * a;
        magB += b * b;
    });
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

function safeSetLocalStorage(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function safeRemoveLocalStorage(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────
//  3. FEEDBACK STORE (localStorage — per-org isolated)
// ─────────────────────────────────────────
const FeedbackStore = {
    _namespace: 'default',   // updated when org switches

    _key(suffix) { return `azpatch_org_${this._namespace}_${suffix}`; },

    // Called by AzureDevOpsService.setActiveOrg()
    setOrgNamespace(orgId) {
        this._namespace = orgId || 'default';
    },

    _read() {
        try { return JSON.parse(localStorage.getItem(this._key('feedback')) || '{}'); }
        catch { return {}; }
    },
    _save(data) { return safeSetLocalStorage(this._key('feedback'), JSON.stringify(data)); },

    getBoost(patchId) {
        const d = this._read();
        return d[patchId] ? d[patchId].boost : 1.0;
    },

    recordFeedback(patchId, isPositive) {
        const d = this._read();
        if (!d[patchId]) d[patchId] = { positive: 0, negative: 0, boost: 1.0 };
        if (isPositive) {
            d[patchId].positive++;
            d[patchId].boost = Math.min(2.5, d[patchId].boost + 0.25);
        } else {
            d[patchId].negative++;
            d[patchId].boost = Math.max(0.1, d[patchId].boost - 0.2);
        }
        this._save(d);
        return d[patchId];
    },

    getStats(patchId) {
        const d = this._read();
        return d[patchId] || { positive: 0, negative: 0, boost: 1.0 };
    },

    getAllStats() { return this._read(); },

    // Ticket history — org-isolated
    saveTicket(ticket) {
        const history = this.getHistory();
        history.unshift(ticket);
        if (history.length > 50) history.pop();
        safeSetLocalStorage(this._key('history'), JSON.stringify(history));
    },

    getHistory() {
        try { return JSON.parse(localStorage.getItem(this._key('history')) || '[]'); }
        catch { return []; }
    },

    updateTicket(ticketId, updater) {
        const history = this.getHistory();
        const idx = history.findIndex(t => t.id === ticketId);
        if (idx === -1) return null;

        const current = history[idx];
        const next = typeof updater === 'function'
            ? (updater({ ...current }) || current)
            : { ...current, ...(updater || {}) };

        history[idx] = next;
        if (!safeSetLocalStorage(this._key('history'), JSON.stringify(history))) return null;
        return next;
    },

    clearAll() {
        safeRemoveLocalStorage(this._key('feedback'));
        safeRemoveLocalStorage(this._key('history'));
    }
};

// ─────────────────────────────────────────
//  3b. TRAINING STORE (localStorage-backed)
// ─────────────────────────────────────────
const TrainingStore = {
    TRAINING_KEY: 'azpatch_training_corpus',

    getAll() {
        try {
            return JSON.parse(localStorage.getItem(this.TRAINING_KEY) || '[]');
        } catch { return []; }
    },

    add(ticket) {
        const normalizedTicket = normalizeTicketForModel(ticket);
        const all = this.getAll().map(t => normalizeTicketForModel(t));
        // Avoid duplicates by adoId or generated id
        const key = String(normalizedTicket.adoId || normalizedTicket.id);
        const signature = ticketContentSignature(normalizedTicket);
        if (all.some(t => String(t.adoId || t.id) === key || ticketContentSignature(t) === signature)) {
            return { ok: false, error: 'Ticket already in training corpus' };
        }
        all.push(normalizedTicket);
        if (!safeSetLocalStorage(this.TRAINING_KEY, JSON.stringify(all))) {
            return { ok: false, error: 'Storage is full. Remove some history/training items and retry.' };
        }
        return { ok: true };
    },

    remove(id) {
        const key = String(id);
        const all = this.getAll().filter(t => String(t.adoId || t.id) !== key);
        return safeSetLocalStorage(this.TRAINING_KEY, JSON.stringify(all));
    },

    clear() {
        return safeRemoveLocalStorage(this.TRAINING_KEY);
    },

    count() {
        return this.getAll().length;
    }
};

function getRecommendationCorpus() {
    const imported = (typeof TicketIntegrations !== 'undefined' && TicketIntegrations.getImportedTickets)
        ? TicketIntegrations.getImportedTickets()
        : [];
    const trained = TrainingStore.getAll();
    const all = [...HISTORICAL_TICKETS, ...imported, ...trained].map(t => normalizeTicketForModel(t));
    const seen = new Set();
    return all.filter(t => {
        const key = String(t.id || t.adoId || t.externalId || '').trim();
        const signature = ticketContentSignature(t);
        const dedupeKey = key ? `id:${key}` : `sig:${signature}`;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
    });
}

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8080';

const RecommendationSettings = {
    SETTINGS_KEY: 'az_recommendation_settings',
    _defaults: {
        debugMode: false,
        backendEnabled: false,
        backendUrl: DEFAULT_BACKEND_URL,
        backendTopK: 5,
        backendStatus: 'unknown'
    },
    get() {
        try {
            const saved = JSON.parse(localStorage.getItem(this.SETTINGS_KEY) || '{}');
            return { ...this._defaults, ...saved };
        } catch {
            return { ...this._defaults };
        }
    },
    save(patch) {
        const updated = { ...this.get(), ...(patch || {}) };
        try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(updated)); } catch { }
        return updated;
    },
    isDebugEnabled() {
        return !!this.get().debugMode;
    }
};

const BackendRecommendationService = {
    TIMEOUT_MS: 12000,

    _normalizeBaseUrl(url) {
        return String(url || '').trim().replace(/\/+$/, '');
    },

    getConfig() {
        const s = RecommendationSettings.get();
        return {
            enabled: !!s.backendEnabled,
            url: this._normalizeBaseUrl(s.backendUrl || DEFAULT_BACKEND_URL),
            topK: Math.max(1, Math.min(10, Number(s.backendTopK || 5))),
            status: String(s.backendStatus || 'unknown')
        };
    },

    isEnabled() {
        return this.getConfig().enabled;
    },

    _buildLocalCorpus(ticket, limit = 180) {
        const fullText = `${ticket.title || ''} ${ticket.description || ticket.desc || ''} ${ticket.tags || ''}`.trim();
        let candidates = [];
        try {
            if (typeof PatchRecommender !== 'undefined' && PatchRecommender._scoreTickets) {
                candidates = PatchRecommender._scoreTickets(fullText, ticket.severity, ticket.system)
                    .slice(0, limit)
                    .map(s => s.ticket);
            }
        } catch { }

        if (!candidates.length) {
            candidates = getRecommendationCorpus().slice(0, limit);
        }

        return candidates
            .filter(t => t && (t.resolvedPatch || t.resolutionDescription || t.resolution))
            .slice(0, limit)
            .map(t => ({
                id: String(t.id || t.adoId || t.externalId || ''),
                title: t.title || '',
                description: t.description || t.desc || '',
                severity: t.severity || 'medium',
                system: t.system || '',
                tags: Array.isArray(t.tags) ? t.tags : String(t.tags || '').split(/[;,]/g).map(x => x.trim()).filter(Boolean),
                resolvedPatch: t.resolvedPatch || '',
                resolutionDescription: t.resolutionDescription || t.resolution || '',
                status: t.status || t.outcome || '',
                outcome: t.outcome || t.status || '',
                source: t.sourceProvider || t.source || 'local',
                changedDate: t.changedDate || t.timestamp || t.updatedAt || t.createdAt || ''
            }));
    },

    async healthCheck(overrideUrl = '') {
        const baseUrl = this._normalizeBaseUrl(overrideUrl || this.getConfig().url);
        if (!baseUrl) return { ok: false, error: 'Backend URL is empty.' };
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(`${baseUrl}/health`, { method: 'GET', signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) return { ok: false, error: `Backend responded ${res.status}` };
            const data = await res.json();
            return { ok: true, data };
        } catch (err) {
            if (err?.name === 'AbortError') return { ok: false, error: 'Backend health check timed out.' };
            return { ok: false, error: err?.message || 'Backend not reachable.' };
        }
    },

    async recommend(ticket, patches, options = {}) {
        const cfg = this.getConfig();
        const baseUrl = this._normalizeBaseUrl(options.backendUrl || cfg.url);
        if (!baseUrl) return { success: false, error: 'Backend URL is empty.' };

        const topK = Math.max(1, Math.min(10, Number(options.topK || cfg.topK || 5)));
        const localCorpus = this._buildLocalCorpus(ticket, options.corpusLimit || 180);
        const payload = {
            query: {
                title: ticket.title || '',
                description: ticket.description || ticket.desc || '',
                severity: ticket.severity || 'medium',
                system: ticket.system || '',
                tags: Array.isArray(ticket.tags) ? ticket.tags : String(ticket.tags || '').split(/[;,]/g).map(x => x.trim()).filter(Boolean)
            },
            patches: (patches || []).map(p => ({
                id: p.id,
                name: p.name || p.id,
                description: p.description || '',
                tags: Array.isArray(p.tags) ? p.tags : [],
                riskLevel: p.riskLevel || 'medium',
                type: p.type || 'template'
            })),
            local_corpus: localCorpus,
            top_k: topK,
            debug: !!options.debug,
            embedding_model: options.embeddingModel || 'nomic-embed-text'
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
        try {
            const res = await fetch(`${baseUrl}/v1/recommend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!res.ok) {
                const errText = await res.text();
                return { success: false, error: `Backend error ${res.status}: ${errText.slice(0, 180)}` };
            }

            const data = await res.json();
            const patchMap = Object.fromEntries((patches || []).map(p => [String(p.id), p]));
            const similarIncidents = Array.isArray(data.similarIncidents)
                ? data.similarIncidents.map(si => ({
                    ticket: {
                        id: String(si.ticketId || 'unknown'),
                        title: String(si.title || 'Untitled incident'),
                        resolvedPatch: si.resolvedPatch || '',
                        resolutionDescription: si.resolutionDescription || '',
                        severity: si.severity || '',
                        system: si.system || '',
                        sourceProvider: si.source || 'backend-corpus'
                    },
                    similarity: Number(si.similarity || 0)
                }))
                : [];

            const recommendations = Array.isArray(data.recommendations)
                ? data.recommendations.map(item => {
                    const patchId = String(item.patchId || '');
                    const patch = patchMap[patchId];
                    if (!patch) return null;

                    const parsedConfidence = Number(item.confidence);
                    const rawConfidence = Math.round(clamp(Number.isFinite(parsedConfidence) ? parsedConfidence : 50, 1, 98));
                    const feedbackMultiplier = FeedbackStore.getBoost(patch.id);
                    const adjustedConfidence = Math.min(
                        98,
                        Math.max(
                            1,
                            Math.round(rawConfidence * (feedbackMultiplier > 1
                                ? 1 + ((feedbackMultiplier - 1) * 0.3)
                                : feedbackMultiplier))
                        )
                    );
                    const feedbackStats = FeedbackStore.getStats(patch.id);

                    return {
                        patch,
                        confidence: adjustedConfidence,
                        adjustedConfidence,
                        reasoning: item.reasoning || 'Recommended by backend hybrid retrieval.',
                        matchCount: Array.isArray(item.evidence) ? item.evidence.length : similarIncidents.length,
                        matchedTickets: similarIncidents.slice(0, 3),
                        feedbackStats,
                        source: 'backend',
                        finalScore: Number(item.score || 0),
                        debug: options.debug ? {
                            engine: 'backend',
                            rawConfidence,
                            adjustedConfidence,
                            feedbackMultiplier,
                            rerankerScore: Number(item.score || 0),
                            topTerms: Object.keys(item.features || {})
                        } : null
                    };
                }).filter(Boolean)
                : [];

            recommendations.sort((a, b) => (b.finalScore || b.confidence) - (a.finalScore || a.confidence));

            return {
                success: true,
                recommendations: recommendations.slice(0, topK),
                similarIncidents,
                abstained: !!data.abstained,
                abstainReason: data.abstainReason || '',
                engine: data.engine || 'hybrid-rag-api',
                debug: data.debug || {}
            };
        } catch (err) {
            clearTimeout(timer);
            if (err?.name === 'AbortError') {
                return { success: false, error: `Backend request timed out after ${this.TIMEOUT_MS / 1000}s.` };
            }
            return { success: false, error: err?.message || 'Backend request failed.' };
        }
    },

    async recordFeedback(patchId, vote) {
        const cfg = this.getConfig();
        if (!cfg.enabled || !cfg.url) return { ok: false, skipped: true };
        try {
            const res = await fetch(`${cfg.url}/v1/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patchId, vote })
            });
            if (!res.ok) return { ok: false };
            return { ok: true, data: await res.json() };
        } catch {
            return { ok: false };
        }
    }
};


// ─────────────────────────────────────────
//  4. PATCH RECOMMENDER ENGINE
// ─────────────────────────────────────────
const PatchRecommender = {

    _buildWeightedTokens(ticket) {
        const titleTokens = tokenize(ticket.title || '');
        const descTokens = tokenize(ticket.description || ticket.desc || '');
        const tagTokens = tokenize(Array.isArray(ticket.tags) ? ticket.tags.join(' ') : String(ticket.tags || ''));
        const resolutionTokens = tokenize(ticket.resolutionDescription || ticket.resolution || '');
        const codeTokens = tokenize(Array.isArray(ticket.codeSnippets)
            ? ticket.codeSnippets.map(s => `${s.file || ''} ${s.snippet || ''}`).join(' ')
            : '');
        const systemNorm = normalizeSystemValue(ticket.system);
        const severityNorm = normalizeSeverityValue(ticket.severity);

        const tokens = [
            ...repeatTokens(titleTokens, 3),
            ...repeatTokens(descTokens, 2),
            ...repeatTokens(tagTokens, 3),
            ...repeatTokens(resolutionTokens, 2),
            ...repeatTokens(codeTokens, 2)
        ];
        if (systemNorm) tokens.push(`system_${systemNorm}`, `system_${systemNorm}`);
        if (severityNorm) tokens.push(`severity_${severityNorm}`);
        return tokens;
    },

    _buildCorpusModel() {
        const seen = new Set();
        const entries = [];

        getRecommendationCorpus().forEach(ticket => {
            const key = String(
                ticket.id
                || ticket.adoId
                || ticket.externalId
                || ticket.sourceUrl
                || `${ticket.title || ''}|${ticket.description || ''}`.slice(0, 180)
            ).toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            const tokens = this._buildWeightedTokens(ticket);
            if (!tokens.length) return;

            entries.push({
                ticket,
                tokens,
                tokenSet: new Set(tokens),
                tf: buildTermFrequency(tokens),
                docLen: tokens.length || 1,
                severityNorm: normalizeSeverityValue(ticket.severity),
                systemNorm: normalizeSystemValue(ticket.system)
            });
        });

        const idf = buildIDF(entries.map(e => Array.from(e.tokenSet)));
        const docFreq = {};
        let totalDocLen = 0;
        entries.forEach(entry => {
            entry.vec = buildTFVector(entry.tokens, idf);
            totalDocLen += entry.docLen;
            entry.tokenSet.forEach(t => { docFreq[t] = (docFreq[t] || 0) + 1; });
        });

        return {
            entries,
            idf,
            docFreq,
            totalDocs: entries.length,
            avgDocLen: totalDocLen / (entries.length || 1)
        };
    },

    _buildInputFeatures(inputText, severity, system, idf) {
        const queryTokens = tokenize(inputText || '');
        const systemNorm = normalizeSystemValue(system);
        const severityNorm = normalizeSeverityValue(severity);

        const tokens = [...repeatTokens(queryTokens, 3)];

        return {
            tokens,
            tokenSet: new Set(tokens),
            vec: buildTFVector(tokens, idf),
            severityNorm,
            systemNorm
        };
    },

    _sharedSignalCount(querySet, ticketSet) {
        let shared = 0;
        querySet.forEach(t => {
            if (!ticketSet.has(t)) return;
            if (t.startsWith('code_') || /\d/.test(t) || t.includes('deadlock') || t.includes('timeout') || t.includes('oom')) {
                shared++;
            }
        });
        return shared;
    },

    _scoreTickets(inputText, severity, system) {
        const { entries, idf, docFreq, totalDocs, avgDocLen } = this._buildCorpusModel();
        if (!entries.length) return [];

        const query = this._buildInputFeatures(inputText, severity, system, idf);
        if (!query.tokens.length) return [];

        const rawScores = entries.map(entry => {
            const base = cosineSimilarity(query.vec, entry.vec);
            const bm25Raw = bm25Score(query.tokens, entry.tf, entry.docLen, docFreq, totalDocs, avgDocLen);
            const overlap = lexicalOverlap(query.tokenSet, entry.tokenSet);
            const sharedSignals = this._sharedSignalCount(query.tokenSet, entry.tokenSet);

            return { entry, base, bm25Raw, overlap, sharedSignals };
        });

        const maxBm25 = Math.max(0.00001, ...rawScores.map(r => r.bm25Raw));
        const scores = rawScores.map(r => {
            const bm25Norm = r.bm25Raw / maxBm25;
            let sim =
                (bm25Norm * 0.5) +
                (r.base * 0.34) +
                (r.overlap * 0.16);

            sim *= 1 + Math.min(0.22, r.sharedSignals * 0.065);

            if (query.severityNorm && r.entry.severityNorm) {
                sim *= query.severityNorm === r.entry.severityNorm ? 1.1 : 0.93;
            }

            if (query.systemNorm && r.entry.systemNorm) {
                if (query.systemNorm === r.entry.systemNorm) sim *= 1.18;
                else if (query.systemNorm.includes('sql') && r.entry.systemNorm.includes('sql')) sim *= 1.04;
                else sim *= 0.95;
            }

            if (r.entry.ticket.outcome === 'resolved' || r.entry.ticket.status === 'resolved') sim *= 1.03;
            if (r.entry.ticket.source === 'azure-devops' || r.entry.ticket.sourceProvider) sim *= 1.01;

            sim = clamp(sim, 0, 0.99);
            return {
                ticket: r.entry.ticket,
                similarity: sim,
                bm25: bm25Norm,
                cosine: r.base,
                overlap: r.overlap,
                sharedSignals: r.sharedSignals
            };
        }).filter(s => s.similarity > 0);

        scores.sort((a, b) => b.similarity - a.similarity);
        return scores;
    },

    _feedbackFactor(patchId) {
        const boost = FeedbackStore.getBoost(patchId);
        const stats = FeedbackStore.getStats(patchId);
        const positive = Number(stats.positive || 0);
        const negative = Number(stats.negative || 0);
        const votes = positive + negative;
        if (!votes) return { multiplier: boost, delta: 0 };

        // Bayesian smoothing avoids overreacting to tiny vote counts.
        const bayesApproval = (positive + 2) / (votes + 4);
        const reliability = Math.min(1, votes / 8);
        const voteLift = 1 + ((bayesApproval - 0.5) * 0.36 * reliability);
        const multiplier = clamp(boost * voteLift, 0.1, 2.8);

        return { multiplier, delta: (bayesApproval - 0.5) * reliability };
    },

    _buildReasoning(data, querySeverityNorm, querySystemNorm) {
        const reasonBits = [];
        reasonBits.push(`${data.count} similar resolved ticket${data.count !== 1 ? 's' : ''}`);

        if (querySystemNorm && data.systemHits > 0) {
            reasonBits.push(`system match ${data.systemHits}/${data.count}`);
        }

        if (querySeverityNorm && data.severityHits > 0) {
            reasonBits.push(`severity match ${data.severityHits}/${data.count}`);
        }

        const topTerms = Object.entries(data.sharedTerms || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([term]) => term);

        if (topTerms.length) {
            reasonBits.push(`matched signals: ${topTerms.join(', ')}`);
        }

        return `Matched ${reasonBits.join(' · ')}.`;
    },

    recommend(inputText, severity, system, topN = 5, options = {}) {
        if (!String(inputText || '').trim()) return [];
        const debugMode = !!options.debug;
        const querySeverityNorm = normalizeSeverityValue(severity);
        const querySystemNorm = normalizeSystemValue(system);

        const ranked = this._scoreTickets(inputText, severity, system);
        if (!ranked.length) return [];

        const topSimilarity = ranked[0].similarity;
        const similarityFloor = Math.max(0.03, topSimilarity * 0.22);
        const topMatches = ranked
            .slice(0, 24)
            .filter(s => s.similarity >= similarityFloor);

        const patchScores = {};
        const queryTermsForSignals = new Set(tokenize(`${inputText || ''} ${system || ''}`));
        topMatches.forEach(({ ticket, similarity }) => {
            const patchId = ticket.resolvedPatch;
            if (!patchId) return;
            if (!patchScores[patchId]) {
                patchScores[patchId] = {
                    rawScore: 0,
                    count: 0,
                    matchedTickets: [],
                    signalHits: 0,
                    sharedTerms: {},
                    severityHits: 0,
                    systemHits: 0
                };
            }
            patchScores[patchId].rawScore += similarity;
            patchScores[patchId].count++;
            patchScores[patchId].matchedTickets.push({ ticket, similarity });

            const ticketSeverityNorm = normalizeSeverityValue(ticket.severity);
            const ticketSystemNorm = normalizeSystemValue(ticket.system);
            if (querySeverityNorm && ticketSeverityNorm === querySeverityNorm) patchScores[patchId].severityHits++;
            if (querySystemNorm && ticketSystemNorm === querySystemNorm) patchScores[patchId].systemHits++;

            if ((ticket.title || '').match(/\d{3,5}/) || (ticket.description || '').match(/\d{3,5}/)) {
                patchScores[patchId].signalHits++;
            }

            const ticketTerms = new Set(this._buildWeightedTokens(ticket));
            queryTermsForSignals.forEach(t => {
                if (!ticketTerms.has(t)) return;
                if (t.startsWith('system_') || t.startsWith('severity_')) return;
                patchScores[patchId].sharedTerms[t] = (patchScores[patchId].sharedTerms[t] || 0) + 1;
            });
        });

        const recommendations = Object.entries(patchScores).map(([patchId, data]) => {
            const patch = PATCH_LIBRARY.find(p => p.id === patchId);
            if (!patch) return null;

            const avgSim = data.rawScore / data.count;
            const supportBoost = 1 + Math.min(0.24, Math.log2(data.count + 1) * 0.09);
            const signalBoost = 1 + Math.min(0.12, data.signalHits * 0.025);
            const severityBoost = querySeverityNorm ? 1 + (data.severityHits / data.count) * 0.12 : 1;
            const systemBoost = querySystemNorm ? 1 + (data.systemHits / data.count) * 0.18 : 1;
            const feedback = this._feedbackFactor(patchId);
            const finalScore = avgSim * supportBoost * signalBoost * severityBoost * systemBoost * feedback.multiplier;

            const confidenceBase =
                avgSim * 72 +
                Math.min(14, data.count * 3.5) +
                (severityBoost - 1) * 22 +
                (systemBoost - 1) * 24 +
                feedback.delta * 20;
            const confidence = Math.round(clamp(confidenceBase, 12, 98));
            const feedbackStats = FeedbackStore.getStats(patchId);

            const matchedTickets = data.matchedTickets
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, 3);

            return {
                patch,
                confidence,
                finalScore,
                avgSimilarity: avgSim,
                matchCount: data.count,
                matchedTickets,
                feedbackStats,
                reasoning: this._buildReasoning(data, querySeverityNorm, querySystemNorm),
                debug: debugMode ? {
                    engine: 'tfidf',
                    topSimilarity,
                    similarityFloor,
                    avgSimilarity: avgSim,
                    supportBoost,
                    signalBoost,
                    severityBoost,
                    systemBoost,
                    feedbackMultiplier: feedback.multiplier,
                    feedbackDelta: feedback.delta,
                    finalScore,
                    confidence,
                    signalHits: data.signalHits,
                    topTerms: Object.entries(data.sharedTerms || {})
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([term]) => term)
                } : null
            };
        }).filter(Boolean);

        recommendations.sort((a, b) => b.finalScore - a.finalScore);

        const top = recommendations[0];
        const second = recommendations[1];
        if (top) {
            const margin = second
                ? (top.finalScore - second.finalScore) / Math.max(top.finalScore, 0.0001)
                : 1;
            const weakEvidence = top.confidence < 46 || top.avgSimilarity < 0.11;
            const ambiguous = !!second && margin < 0.08 && top.confidence < 64;
            if (weakEvidence || ambiguous) return [];
        }

        return recommendations.slice(0, topN);
    },

    findSimilarResolvedTickets(inputText, severity, system, topN = 5) {
        if (!String(inputText || '').trim()) return [];
        const scored = this._scoreTickets(inputText, severity, system)
            .filter(s =>
                s.ticket?.outcome === 'resolved'
                || s.ticket?.status === 'resolved'
                || s.ticket?.sourceProvider
                || s.ticket?.adoId
            );

        if (!scored.length) return [];
        const floor = Math.max(0.03, scored[0].similarity * 0.2);
        return scored
            .filter(s => s.similarity >= floor)
            .slice(0, topN);
    }
};

// ─────────────────────────────────────────
//  5. ANALYTICS ENGINE
// ─────────────────────────────────────────
const Analytics = {
    getPatchSuccessRates() {
        const rates = {};
        const feedbackStats = FeedbackStore.getAllStats();
        const corpus = getRecommendationCorpus();

        PATCH_LIBRARY.forEach(patch => {
            const usageCount = corpus.filter(t => t.resolvedPatch === patch.id).length;
            const avgRating = corpus
                .filter(t => t.resolvedPatch === patch.id)
                .reduce((sum, t) => sum + (t.feedbackRating || 3), 0) / (usageCount || 1);

            const fb = feedbackStats[patch.id] || { positive: 0, negative: 0 };
            const userFeedbackScore = fb.positive + fb.negative > 0
                ? (fb.positive / (fb.positive + fb.negative)) * 5
                : null;

            rates[patch.id] = {
                patch,
                usageCount,
                avgRating,
                userFeedbackScore,
                successRate: Math.round((avgRating / 5) * 100)
            };
        });
        return rates;
    },

    getSeverityDistribution() {
        const dist = { critical: 0, high: 0, medium: 0, low: 0 };
        getRecommendationCorpus().forEach(t => { if (dist[t.severity] !== undefined) dist[t.severity]++; });
        const history = FeedbackStore.getHistory();
        history.forEach(t => { if (dist[t.severity] !== undefined) dist[t.severity]++; });
        return dist;
    },

    getSystemDistribution() {
        const dist = {};
        getRecommendationCorpus().forEach(t => {
            if (!t.system) return;
            const key = String(t.system).split(' ').slice(0, 2).join(' ');
            dist[key] = (dist[key] || 0) + 1;
        });
        return dist;
    },

    getTopPatches(n = 5) {
        const rates = this.getPatchSuccessRates();
        return Object.values(rates)
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, n);
    },

    getResolutionTimeSummary() {
        const corpus = getRecommendationCorpus();
        const resolvedTimes = corpus
            .map(t => Number(t.resolutionTime || 0))
            .filter(v => Number.isFinite(v) && v > 0);
        const avg = resolvedTimes.reduce((s, v) => s + v, 0) / (resolvedTimes.length || 1);
        const history = FeedbackStore.getHistory();
        const total = corpus.length + history.length;
        const resolved = corpus.filter(t => t.outcome === 'resolved' || t.status === 'resolved').length +
            history.filter(t => t.status === 'resolved').length;
        return { avg: avg.toFixed(1), total, resolved, resolutionRate: Math.round((resolved / (total || 1)) * 100) };
    }
};

// ─────────────────────────────────────────
//  6. CHART MANAGER
// ─────────────────────────────────────────
const ChartManager = {
    _charts: {},

    destroy(id) {
        if (this._charts[id]) {
            this._charts[id].destroy();
            delete this._charts[id];
        }
    },

    renderPatchUsageChart(canvasId) {
        this.destroy(canvasId);
        const top = Analytics.getTopPatches(8);
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;

        this._charts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: top.map(t => t.patch.name.replace(' Patch', '').replace(' Fix', '')),
                datasets: [{
                    label: 'Times Applied',
                    data: top.map(t => t.usageCount),
                    backgroundColor: [
                        '#3b7df0', '#1f9fbe', '#f08a24', '#d9a62e', '#e15a67',
                        '#38ac7f', '#5f90f0', '#3fc0d9'
                    ],
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            afterLabel: (ctx) => `Success: ${top[ctx.dataIndex].successRate}%`
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: '#5f7390', maxRotation: 40, font: { size: 11 } }, grid: { color: '#dbe5f1' } },
                    y: { ticks: { color: '#5f7390' }, grid: { color: '#dbe5f1' }, beginAtZero: true }
                }
            }
        });
    },

    renderSeverityChart(canvasId) {
        this.destroy(canvasId);
        const dist = Analytics.getSeverityDistribution();
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;

        this._charts[canvasId] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Critical', 'High', 'Medium', 'Low'],
                datasets: [{
                    data: [dist.critical, dist.high, dist.medium, dist.low],
                    backgroundColor: ['#ff4757', '#ff6b35', '#ffd32a', '#2ed573'],
                    borderColor: '#ffffff',
                    borderWidth: 3
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#5f7390', padding: 16 } }
                },
                cutout: '65%'
            }
        });
    },

    renderSystemChart(canvasId) {
        this.destroy(canvasId);
        const dist = Analytics.getSystemDistribution();
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;

        const labels = Object.keys(dist);
        const data = Object.values(dist);
        this._charts[canvasId] = new Chart(ctx, {
            type: 'polarArea',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: [
                        '#3b7df077', '#1f9fbe77', '#f08a2477', '#d9a62e77',
                        '#e15a6777', '#38ac7f77', '#5f90f077', '#3fc0d977'
                    ],
                    borderColor: '#ffffff',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'right', labels: { color: '#5f7390', font: { size: 11 } } } },
                scales: { r: { ticks: { color: '#5f7390', backdropColor: 'transparent' }, grid: { color: '#dbe5f1' } } }
            }
        });
    },

    renderSuccessRateChart(canvasId) {
        this.destroy(canvasId);
        const rates = Analytics.getPatchSuccessRates();
        const top = Object.values(rates).sort((a, b) => b.successRate - a.successRate).slice(0, 8);
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;

        this._charts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: top.map(t => t.patch.name.replace(' Patch', '').replace(' Fix', '').replace(' Resolution', '')),
                datasets: [{
                    label: 'Success Rate %',
                    data: top.map(t => t.successRate),
                    backgroundColor: top.map(t => t.successRate >= 90 ? '#2ed573' : t.successRate >= 70 ? '#ffd32a' : '#ff6b35'),
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#5f7390', callback: v => v + '%' }, grid: { color: '#dbe5f1' }, max: 100, beginAtZero: true },
                    y: { ticks: { color: '#5f7390', font: { size: 11 } }, grid: { color: '#dbe5f1' } }
                }
            }
        });
    }
};

// ─────────────────────────────────────────
//  7. UI CONTROLLER
// ─────────────────────────────────────────
const UI = {
    activeTab: 'submit',
    currentResults: [],
    currentSimilarIncidents: [],
    activeTicketId: null,
    activeIntegrationProfileId: null,
    recommendationDebug: false,
    _quickSettingsOpen: false,

    init() {
        this.recommendationDebug = RecommendationSettings.isDebugEnabled();
        this._populateSystemSelect();
        this._bindNavigation();
        this._bindBrandHomeRoute();
        this._bindForm();
        this._bindAdoFetch();
        this._bindSearch();
        this._renderStats();
        this._renderHistory();
        this._setupThemeParticles();
        this._initOllamaState();
        this._initIntegrations();
        this._initTrainTab();
        this._initQuickSettingsMenu();
        this._bindWelcomeHero();
    },

    _bindWelcomeHero() {
        const btn = document.getElementById('org-onboarding-open-settings-btn');
        if (btn) btn.addEventListener('click', () => {
            this._closeQuickSettingsMenu();
            SettingsModal.open('onboarding');
        });
        this._syncLandingMode();
    },

    _bindBrandHomeRoute() {
        const brandHomeLink = document.getElementById('brand-home-link');
        if (!brandHomeLink) return;

        brandHomeLink.addEventListener('click', (e) => {
            e.preventDefault();
            this._closeQuickSettingsMenu();

            if (this._syncLandingMode()) {
                this._switchTab('submit');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }

            document.body.classList.add('landing-active');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    },

    _isActiveIntegrationReady() {
        if (typeof TicketIntegrations === 'undefined') return false;
        const active = TicketIntegrations.getActiveProfile();
        if (!active) return false;
        const provider = TicketIntegrations.getProvider(active.provider);
        if (!provider) return false;
        const requiredFields = (provider.fields || []).filter(f => f.required);
        return requiredFields.every(field => String(active.config?.[field.key] || '').trim().length > 0);
    },

    _syncLandingMode() {
        const ready = this._isActiveIntegrationReady();
        document.body.classList.toggle('landing-active', !ready);
        return ready;
    },

    _requireIntegrationReady(openSettings = false) {
        const ready = this._syncLandingMode();
        if (ready) return true;
        if (openSettings) SettingsModal.open('onboarding');
        return false;
    },

    _enterWorkspaceAfterIntegration() {
        document.body.classList.remove('landing-active');
        this._switchTab('submit');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    _baseModelChoices() {
        return [
            { value: 'phi4', label: 'phi4 — best technical reasoning' },
            { value: 'llama3.2', label: 'llama3.2 — fast and lightweight' },
            { value: 'llama3.1', label: 'llama3.1 — balanced quality/speed' },
            { value: 'mistral', label: 'mistral — compact reasoning' },
            { value: 'qwen2.5-coder', label: 'qwen2.5-coder — code focused' },
            { value: 'deepseek-r1', label: 'deepseek-r1 — stronger reasoning' }
        ];
    },

    _hostFromUrl(rawUrl = '') {
        const val = String(rawUrl || '').trim();
        if (!val) return '';
        try {
            return new URL(val).hostname.replace(/^www\./i, '');
        } catch {
            return val.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
        }
    },

    _renderQuickRuntimeDetails(opts = {}) {
        const engineChip = document.getElementById('quick-engine-mode');
        const modelMeta = document.getElementById('quick-model-meta');
        const ollama = OllamaService.getSettings();
        const reco = RecommendationSettings.get();
        const activeModel = String(opts.model || ollama.model || 'phi4').trim() || 'phi4';

        let engineText = 'Hybrid Local';
        let engineClass = 'quick-mode-chip quick-mode-chip--hybrid';
        if (reco.backendEnabled) {
            if (reco.backendStatus === 'connected') {
                engineText = 'Backend RAG';
                engineClass = 'quick-mode-chip quick-mode-chip--backend';
            } else {
                engineText = 'Backend Offline';
                engineClass = 'quick-mode-chip quick-mode-chip--warn';
            }
        } else if (ollama.enabled && ollama.lastStatus === 'connected') {
            engineText = 'Ollama LLM';
            engineClass = 'quick-mode-chip quick-mode-chip--llm';
        } else if (ollama.enabled) {
            engineText = 'Ollama Offline';
            engineClass = 'quick-mode-chip quick-mode-chip--warn';
        }

        if (engineChip) {
            engineChip.textContent = engineText;
            engineChip.className = engineClass;
        }

        if (modelMeta) {
            const sourceStatus = reco.backendEnabled
                ? (reco.backendStatus === 'connected' ? 'Backend connected' : 'Backend unavailable')
                : (ollama.enabled ? (ollama.lastStatus === 'connected' ? 'Ollama connected' : 'Ollama unavailable') : 'Hybrid local retrieval');
            modelMeta.textContent = `Active model: ${activeModel} · ${sourceStatus}`;
        }
    },

    _syncModelSelectors(selectedModel = '', runtimeModels = []) {
        const selected = String(selectedModel || '').trim() || 'phi4';
        const baseChoices = this._baseModelChoices();
        const merged = new Map();

        baseChoices.forEach(choice => merged.set(choice.value, choice.label));
        (runtimeModels || []).forEach(model => {
            const m = String(model || '').trim();
            if (!m) return;
            if (!merged.has(m)) merged.set(m, `${m} — installed locally`);
        });
        if (!merged.has(selected)) merged.set(selected, `${selected} — current`);

        const modalSelect = document.getElementById('ollama-model');
        const quickSelect = document.getElementById('quick-llm-model');
        const options = Array.from(merged.entries());

        const render = (el) => {
            if (!el) return;
            el.innerHTML = options
                .map(([value, label]) => `<option value="${this._escapeHtml(value)}">${this._escapeHtml(label)}</option>`)
                .join('');
            el.value = selected;
        };

        render(modalSelect);
        render(quickSelect);
        this._renderQuickRuntimeDetails({ model: selected });
    },

    _applyModelSelection(model, opts = {}) {
        const nextModel = String(model || '').trim();
        if (!nextModel) return;
        OllamaService.saveSettings({ model: nextModel });
        this._syncModelSelectors(nextModel);

        const s = OllamaService.getSettings();
        const reco = RecommendationSettings.get();
        this._updateEngineIndicator(s.enabled, s.lastStatus, reco.backendEnabled, reco.backendStatus);
        if (opts.showToast) this._showToast(`Model changed to "${nextModel}".`, 'info');
    },

    _renderQuickAccountDetails() {
        const nameEl = document.getElementById('quick-account-name');
        const scopeEl = document.getElementById('quick-account-scope');
        const metaEl = document.getElementById('quick-account-meta');
        if (!nameEl || !metaEl) return;

        if (typeof TicketIntegrations === 'undefined') {
            nameEl.textContent = 'Local mode';
            if (scopeEl) scopeEl.textContent = 'No workspace connected';
            metaEl.textContent = 'No integration service loaded.';
            return;
        }

        const active = TicketIntegrations.getActiveProfile();
        if (!active) {
            nameEl.textContent = 'No active profile';
            if (scopeEl) scopeEl.textContent = 'No workspace connected';
            metaEl.textContent = 'Connect Azure DevOps or Jira profile in settings.';
            return;
        }

        const provider = TicketIntegrations.getProvider(active.provider)?.label || active.provider;
        const cfg = active.config || {};
        let scopeText = provider;
        if (active.provider === 'azure') {
            const host = this._hostFromUrl(cfg.orgUrl);
            scopeText = `${cfg.project || 'Project'}${host ? ` · ${host}` : ''}`;
        } else if (active.provider === 'jira') {
            const host = this._hostFromUrl(cfg.site);
            scopeText = `${cfg.projectKey || 'Project'}${host ? ` · ${host}` : ''}`;
        }
        const imported = TicketIntegrations.getImportedTickets(active.id).length;
        nameEl.textContent = `${active.name} · ${provider}`;
        if (scopeEl) scopeEl.textContent = scopeText;
        metaEl.textContent = `Imported tickets: ${imported}${active.lastSync ? ` · Last sync: ${new Date(active.lastSync).toLocaleString()}` : ' · Never synced'}`;
    },

    _openQuickSettingsMenu() {
        const settingsBtn = document.getElementById('settings-btn');
        const menu = document.getElementById('quick-settings-menu');
        if (!menu) return;
        menu.classList.add('open');
        this._quickSettingsOpen = true;
        if (settingsBtn) settingsBtn.setAttribute('aria-expanded', 'true');
        this._renderQuickAccountDetails();
        this._syncModelSelectors(OllamaService.getSettings().model);
        this._renderQuickRuntimeDetails();
    },

    _closeQuickSettingsMenu() {
        const settingsBtn = document.getElementById('settings-btn');
        const menu = document.getElementById('quick-settings-menu');
        if (!menu) return;
        menu.classList.remove('open');
        this._quickSettingsOpen = false;
        if (settingsBtn) settingsBtn.setAttribute('aria-expanded', 'false');
    },

    _toggleQuickSettingsMenu() {
        if (this._quickSettingsOpen) this._closeQuickSettingsMenu();
        else this._openQuickSettingsMenu();
    },

    _initQuickSettingsMenu() {
        const settingsBtn = document.getElementById('settings-btn');
        const menu = document.getElementById('quick-settings-menu');
        const quickModelSelect = document.getElementById('quick-llm-model');
        const refreshBtn = document.getElementById('quick-refresh-models-btn');
        const openSettingsBtn = document.getElementById('quick-open-settings-btn');
        if (!settingsBtn || !menu || !quickModelSelect || !refreshBtn || !openSettingsBtn) return;
        settingsBtn.setAttribute('aria-expanded', 'false');

        settingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._toggleQuickSettingsMenu();
        });

        quickModelSelect.addEventListener('change', () => {
            this._applyModelSelection(quickModelSelect.value, { showToast: true });
        });

        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Checking...';
            const result = await OllamaService.checkConnection();
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh Models';
            if (result.connected) {
                const models = result.models || [];
                const preferred = quickModelSelect.value || OllamaService.getSettings().model;
                const next = models.includes(preferred) ? preferred : (models[0] || preferred);
                this._syncModelSelectors(next, models);
                this._applyModelSelection(next);
                this._showToast(`Detected ${models.length} local model(s).`, 'success');
            } else {
                this._showToast(result.error || 'Could not reach Ollama.', 'info');
            }
        });

        openSettingsBtn.addEventListener('click', () => {
            this._closeQuickSettingsMenu();
            SettingsModal.open();
        });

        document.addEventListener('click', (e) => {
            if (!this._quickSettingsOpen) return;
            if (menu.contains(e.target) || settingsBtn.contains(e.target)) return;
            this._closeQuickSettingsMenu();
        });
    },

    // ── Ollama state init ──
    _initOllamaState() {
        const settings = OllamaService.getSettings();
        const recoSettings = RecommendationSettings.get();
        this._updateEngineIndicator(settings.enabled, settings.lastStatus, recoSettings.backendEnabled, recoSettings.backendStatus);
        this._syncModelSelectors(settings.model);
        this._renderQuickRuntimeDetails();
        document.getElementById('ollama-toggle').checked = settings.enabled;
        document.getElementById('ollama-temp').value = settings.temperature;
        document.getElementById('ollama-temp-val').textContent = settings.temperature;
        const recoDebugToggle = document.getElementById('reco-debug-toggle');
        if (recoDebugToggle) recoDebugToggle.checked = !!recoSettings.debugMode;
        const backendToggle = document.getElementById('backend-toggle');
        if (backendToggle) backendToggle.checked = !!recoSettings.backendEnabled;
        const backendUrl = document.getElementById('backend-url');
        if (backendUrl) backendUrl.value = recoSettings.backendUrl || DEFAULT_BACKEND_URL;
        const backendTopK = document.getElementById('backend-topk');
        if (backendTopK) backendTopK.value = String(Math.max(1, Math.min(10, Number(recoSettings.backendTopK || 5))));
        this.recommendationDebug = !!recoSettings.debugMode;
        this._renderQuickAccountDetails();
    },

    _initIntegrations() {
        this._updateTicketSourceIndicator();
        if (typeof TicketIntegrations === 'undefined') {
            this._syncLandingMode();
            return;
        }

        const providerSel = document.getElementById('integration-provider');
        if (!providerSel) {
            this._syncLandingMode();
            return;
        }

        this._populateIntegrationProviders();

        providerSel.addEventListener('change', () => {
            this.activeIntegrationProfileId = null;
            this._renderIntegrationFields(providerSel.value);
            this._setIntegrationStatus('');
        });

        document.getElementById('integration-load-btn').addEventListener('click', () => {
            this._refreshIntegrationSettings();
        });

        document.getElementById('integration-test-btn').addEventListener('click', () => {
            this._testIntegrationProfile();
        });

        document.getElementById('integration-save-btn').addEventListener('click', () => {
            this._saveIntegrationProfile();
        });

        document.getElementById('integration-sync-btn').addEventListener('click', () => {
            this._syncIntegrationProfile();
        });

        this._refreshIntegrationSettings();
    },

    _populateIntegrationProviders() {
        const providerSel = document.getElementById('integration-provider');
        if (!providerSel) return;

        const providers = TicketIntegrations.getProviders();
        providerSel.innerHTML = providers
            .map(p => `<option value="${this._escapeHtml(p.id)}">${this._escapeHtml(p.label)}</option>`)
            .join('');
    },

    _renderIntegrationFields(providerId, values = {}) {
        const container = document.getElementById('integration-fields');
        if (!container) return;

        const provider = TicketIntegrations.getProvider(providerId);
        if (!provider) {
            container.innerHTML = '<div class="settings-hint">Unknown provider selected.</div>';
            return;
        }

        container.innerHTML = provider.fields.map(field => {
            const id = `integration-field-${field.key}`;
            const value = this._escapeHtml(values[field.key] || '');
            const label = this._escapeHtml(field.label);
            const placeholder = this._escapeHtml(field.placeholder || '');
            const type = this._escapeHtml(field.type || 'text');
            const required = field.required ? '<span class="required">*</span>' : '';
            return `
              <div class="integration-field">
                <label class="settings-label" for="${id}">${label} ${required}</label>
                <input id="${id}" class="form-control" type="${type}" placeholder="${placeholder}" value="${value}" />
              </div>
            `;
        }).join('');
    },

    _collectIntegrationDraft() {
        const providerId = document.getElementById('integration-provider')?.value || '';
        const provider = TicketIntegrations.getProvider(providerId);
        if (!provider) return { ok: false, error: 'Select a valid ticket provider.' };

        const nameInput = document.getElementById('integration-name');
        const name = (nameInput?.value || '').trim() || `${provider.label} Profile`;
        const config = {};

        for (const field of provider.fields) {
            const input = document.getElementById(`integration-field-${field.key}`);
            const value = (input?.value || '').trim();
            if (field.required && !value) {
                return { ok: false, error: `${field.label} is required.` };
            }
            config[field.key] = value;
        }

        return {
            ok: true,
            draft: {
                id: this.activeIntegrationProfileId || '',
                name,
                provider: providerId,
                config
            }
        };
    },

    _setIntegrationStatus(message, kind = 'info') {
        const el = document.getElementById('integration-status');
        if (!el) return;
        const colors = {
            info: 'var(--text-sec)',
            success: 'var(--success)',
            danger: 'var(--danger)',
            warning: 'var(--warning)'
        };
        el.style.color = colors[kind] || colors.info;
        el.textContent = message || '';
    },

    _refreshIntegrationSettings() {
        if (typeof TicketIntegrations === 'undefined') {
            this._syncLandingMode();
            return;
        }

        const providerSel = document.getElementById('integration-provider');
        const nameInput = document.getElementById('integration-name');
        if (!providerSel || !nameInput) {
            this._syncLandingMode();
            return;
        }

        const active = TicketIntegrations.getActiveProfile();
        const providers = TicketIntegrations.getProviders();
        const fallbackProvider = providers[0]?.id || 'azure';

        if (active?.id) {
            try {
                TicketIntegrations.setActiveProfile(active.id);
            } catch {
                FeedbackStore.setOrgNamespace('default');
            }
        } else FeedbackStore.setOrgNamespace('default');

        this.activeIntegrationProfileId = active?.id || null;
        providerSel.value = active?.provider || providerSel.value || fallbackProvider;
        this._renderIntegrationFields(providerSel.value, active?.config || {});
        nameInput.value = active?.name || '';

        this._renderIntegrationProfiles();
        this._updateTicketSourceIndicator();
        this._setIntegrationStatus('');
        this._syncLandingMode();
    },

    _renderIntegrationProfiles() {
        const container = document.getElementById('integration-list');
        if (!container || typeof TicketIntegrations === 'undefined') return;

        const profiles = TicketIntegrations.listProfiles();
        const activeId = TicketIntegrations.getActiveProfileId();

        if (!profiles.length) {
            container.innerHTML = '<div class="settings-hint">No profiles saved yet.</div>';
            return;
        }

        container.innerHTML = profiles.map(p => {
            const provider = TicketIntegrations.getProvider(p.provider);
            const importedCount = TicketIntegrations.getImportedTickets(p.id).length;
            const activeBadge = p.id === activeId ? ' • Active' : '';
            return `
              <div class="integration-item" data-profile-id="${this._escapeHtml(p.id)}">
                <div class="integration-item-meta">
                  <span class="integration-item-name">${this._escapeHtml(p.name)} (${this._escapeHtml(provider?.label || p.provider)})${activeBadge}</span>
                  <span class="integration-item-sub">Imported tickets: ${importedCount} · Last sync: ${p.lastSync ? new Date(p.lastSync).toLocaleString() : 'Never'}</span>
                </div>
                <div class="integration-item-actions">
                  <button class="integration-action-btn" data-action="load" data-id="${this._escapeHtml(p.id)}">Load</button>
                  <button class="integration-action-btn" data-action="activate" data-id="${this._escapeHtml(p.id)}">Activate</button>
                  <button class="integration-action-btn" data-action="sync" data-id="${this._escapeHtml(p.id)}">Sync</button>
                  <button class="integration-action-btn" data-action="delete" data-id="${this._escapeHtml(p.id)}">Delete</button>
                </div>
              </div>
            `;
        }).join('');

        container.querySelectorAll('.integration-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._handleIntegrationListAction(btn.dataset.action, btn.dataset.id);
            });
        });
    },

    _loadIntegrationProfile(profileId) {
        const profile = TicketIntegrations.getProfile(profileId);
        if (!profile) {
            this._setIntegrationStatus('Profile not found.', 'danger');
            return;
        }

        this.activeIntegrationProfileId = profile.id;
        document.getElementById('integration-name').value = profile.name || '';
        document.getElementById('integration-provider').value = profile.provider;
        this._renderIntegrationFields(profile.provider, profile.config || {});
        this._setIntegrationStatus(`Loaded profile "${profile.name}".`, 'info');
    },

    _saveIntegrationProfile() {
        if (typeof TicketIntegrations === 'undefined') return;
        const collected = this._collectIntegrationDraft();
        if (!collected.ok) {
            this._setIntegrationStatus(collected.error, 'danger');
            return;
        }

        try {
            const profile = TicketIntegrations.createOrUpdateProfile(collected.draft);
            TicketIntegrations.setActiveProfile(profile.id);
            this.activeIntegrationProfileId = profile.id;
            this._renderIntegrationProfiles();
            this._updateTicketSourceIndicator();
            this._setIntegrationStatus(`Saved and activated profile "${profile.name}".`, 'success');
            if (this._syncLandingMode()) {
                this._showToast(`Organization "${profile.name}" integrated successfully. Opening workspace.`, 'success');
                SettingsModal.close();
                this._enterWorkspaceAfterIntegration();
            }
        } catch (err) {
            this._setIntegrationStatus(err.message || 'Failed to save profile.', 'danger');
        }
    },

    async _testIntegrationProfile() {
        if (typeof TicketIntegrations === 'undefined') return;
        const collected = this._collectIntegrationDraft();
        if (!collected.ok) {
            this._setIntegrationStatus(collected.error, 'danger');
            return;
        }

        this._setIntegrationStatus('Testing connection...', 'info');
        const result = await TicketIntegrations.testProfile(collected.draft);
        if (result.ok) {
            const summary = result.totalCount !== undefined
                ? `Connected. Accessible tickets: ${result.totalCount}.`
                : 'Connected successfully.';
            this._setIntegrationStatus(summary, 'success');
        } else {
            this._setIntegrationStatus(result.error || 'Connection failed.', 'danger');
        }
    },

    async _syncIntegrationProfile(profileId = null) {
        if (typeof TicketIntegrations === 'undefined') return;

        const targetId = profileId || this.activeIntegrationProfileId || TicketIntegrations.getActiveProfileId();
        if (!targetId) {
            this._setIntegrationStatus('Save and activate a profile before syncing.', 'warning');
            return;
        }

        this._setIntegrationStatus('Syncing resolved tickets...', 'info');
        const result = await TicketIntegrations.syncProfile(targetId, { limit: 60 });
        if (!result.ok) {
            this._setIntegrationStatus(result.error || 'Sync failed.', 'danger');
            return;
        }

        this._renderIntegrationProfiles();
        this._updateTicketSourceIndicator();
        this._renderStats();
        if (this.activeTab === 'analytics') this._renderCharts();

        const msg = `Synced ${result.imported} resolved tickets (${result.withMappedPatch} mapped to known patches).`;
        this._setIntegrationStatus(msg, 'success');
        this._showToast(msg, 'success');
    },

    _handleIntegrationListAction(action, profileId) {
        if (!profileId) return;
        if (action === 'load') {
            this._loadIntegrationProfile(profileId);
            return;
        }
        if (action === 'activate') {
            try {
                TicketIntegrations.setActiveProfile(profileId);
                this.activeIntegrationProfileId = profileId;
                this._renderIntegrationProfiles();
                this._updateTicketSourceIndicator();
                this._setIntegrationStatus('Active profile updated.', 'success');
                this._syncLandingMode();
            } catch (err) {
                this._setIntegrationStatus(err.message || 'Could not activate profile.', 'danger');
            }
            return;
        }
        if (action === 'sync') {
            this._syncIntegrationProfile(profileId);
            return;
        }
        if (action === 'delete') {
            const profile = TicketIntegrations.getProfile(profileId);
            const name = profile?.name || profileId;
            const confirmed = window.confirm(`Delete integration profile "${name}" and its imported tickets?`);
            if (!confirmed) return;
            TicketIntegrations.deleteProfile(profileId);
            if (this.activeIntegrationProfileId === profileId) this.activeIntegrationProfileId = null;
            this._renderIntegrationProfiles();
            this._updateTicketSourceIndicator();
            this._setIntegrationStatus('Profile deleted.', 'warning');
            this._syncLandingMode();
        }
    },

    _updateTicketSourceIndicator() {
        this._renderQuickAccountDetails();
        const indicator = document.getElementById('ticket-source-indicator');
        if (!indicator) return;

        if (typeof TicketIntegrations === 'undefined') {
            indicator.textContent = 'Local Corpus';
            indicator.className = 'engine-indicator engine-indicator--warn';
            return;
        }

        const active = TicketIntegrations.getActiveProfile();
        if (!active) {
            indicator.textContent = 'Local Corpus';
            indicator.className = 'engine-indicator engine-indicator--warn';
            return;
        }

        const importedCount = TicketIntegrations.getImportedTickets(active.id).length;
        const providerLabel = TicketIntegrations.getProvider(active.provider)?.label || active.provider;
        indicator.textContent = `${providerLabel} (${importedCount})`;
        indicator.className = 'engine-indicator engine-indicator--llm';
    },

    _populateSystemSelect() {
        const sel = document.getElementById('system');
        DB_SYSTEMS.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s; opt.textContent = s;
            sel.appendChild(opt);
        });
    },

    _bindNavigation() {
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._requireIntegrationReady(true)) return;
                const tab = btn.dataset.tab;
                this._switchTab(tab);
            });
        });
    },

    _switchTab(tab) {
        if (!this._requireIntegrationReady(false)) return;
        this.activeTab = tab;
        document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));

        if (tab === 'analytics') {
            setTimeout(() => this._renderCharts(), 50);
        }
        if (tab === 'history') {
            this._renderHistory();
        }
        if (tab === 'results' && this.currentResults.length === 0 && this.currentSimilarIncidents.length === 0 && !this.activeTicketId) {
            this._switchTab('submit');
        }
        if (tab === 'submit') {
            this._populateSubmitProfileSelect();
        }
        if (tab === 'train') {
            this._renderTrainedList();
            this._populateTrainProfileSelect();
        }
    },

    _bindForm() {
        const form = document.getElementById('ticket-form');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._analyzeTicket();
        });

        document.getElementById('clear-btn').addEventListener('click', () => {
            form.reset();
            document.getElementById('char-count').textContent = '0';
            this._clearValidation();
        });

        document.getElementById('description').addEventListener('input', (e) => {
            document.getElementById('char-count').textContent = e.target.value.length;
        });

        // Example ticket buttons
        document.querySelectorAll('.example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const examples = {
                    deadlock: {
                        title: 'SQL Server deadlock causing production outage',
                        desc: 'SQL Server deadlock detected on production DB. Multiple transactions waiting on each other causing error 1205. High CPU utilization observed. Application reporting timeout exceptions every few minutes. EXEC_LOG shows deadlock graph.',
                        severity: 'critical', system: 'SQL Server 2019'
                    },
                    performance: {
                        title: 'Queries timing out after statistics update',
                        desc: 'Stored procedures timing out after 30 seconds. Execution plans look suboptimal with expensive key lookups. Missing indexes identified. Parameter sniffing suspected. Performance degraded significantly after last week data load.',
                        severity: 'high', system: 'Azure SQL Database'
                    },
                    memory: {
                        title: 'Out of memory errors crashing ETL jobs',
                        desc: 'SQL Server consuming 95% of available RAM. Buffer pool pressure detected with frequent page faults. Out of memory errors appearing in SQL log. Queries being killed due to memory grants failing. RESOURCE_SEMAPHORE waits extremely high.',
                        severity: 'high', system: 'SQL Server 2019'
                    },
                    cosmos: {
                        title: 'Cosmos DB 429 Too Many Requests errors',
                        desc: 'Application receiving HTTP 429 errors from Cosmos DB. Read-heavy workload exceeding provisioned RUs. Hot partition detected from partition key distribution analysis. Need to scale RU allocation and implement retry strategy.',
                        severity: 'high', system: 'Azure Cosmos DB'
                    }
                };
                const ex = examples[btn.dataset.example];
                if (ex) {
                    document.getElementById('title').value = ex.title;
                    document.getElementById('description').value = ex.desc;
                    document.getElementById('severity').value = ex.severity;
                    document.getElementById('system').value = ex.system;
                    document.getElementById('char-count').textContent = ex.desc.length;
                }
            });
        });
    },

    _bindAdoFetch() {
        const fetchBtn = document.getElementById('submit-ado-fetch-btn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', () => this._fetchAndAnalyze());
        }
        // Also allow Enter key in the ID input
        const idInput = document.getElementById('submit-ado-id');
        if (idInput) {
            idInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this._fetchAndAnalyze(); }
            });
        }
        this._populateSubmitProfileSelect();
    },

    _populateSubmitProfileSelect() {
        const sel = document.getElementById('submit-ado-profile');
        if (!sel || typeof TicketIntegrations === 'undefined') return;

        const profiles = TicketIntegrations.listProfiles();
        const activeId = TicketIntegrations.getActiveProfileId();

        sel.innerHTML = profiles.length === 0
            ? '<option value="">— No profiles (configure in Settings) —</option>'
            : profiles.map(p => {
                const provider = TicketIntegrations.getProvider(p.provider);
                const id = this._escapeHtml(p.id);
                const name = this._escapeHtml(p.name);
                const providerLabel = this._escapeHtml(provider?.label || p.provider);
                return `<option value="${id}" ${p.id === activeId ? 'selected' : ''}>${name} (${providerLabel})</option>`;
            }).join('');
    },

    async _fetchAndAnalyze() {
        if (!this._requireIntegrationReady(true)) return;
        const profileId = document.getElementById('submit-ado-profile')?.value;
        const wiIdRaw = document.getElementById('submit-ado-id')?.value.trim();
        const statusEl = document.getElementById('submit-ado-status');
        const fetchBtn = document.getElementById('submit-ado-fetch-btn');

        // Parse work item ID
        let wiId = wiIdRaw;
        const urlMatch = wiIdRaw.match(/\/(\d+)\s*$/);
        if (urlMatch) wiId = urlMatch[1];
        wiId = parseInt(wiId);

        if (!wiId || isNaN(wiId)) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Enter a valid work item ID or URL</span>';
            return;
        }

        if (!profileId) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Select an integration profile first (configure in Settings)</span>';
            return;
        }

        const profile = TicketIntegrations.getProfile(profileId);
        if (!profile) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Profile not found</span>';
            return;
        }
        if (profile.provider !== 'azure' || !profile.config?.orgUrl || !profile.config?.project || !profile.config?.pat) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Selected profile is not ready for Azure fetch. Open Settings and enter org/project/PAT.</span>';
            return;
        }

        const org = {
            orgUrl: profile.config.orgUrl,
            project: profile.config.project,
            pat: profile.config.pat,
            id: profile.id
        };

        // Start fetching
        fetchBtn.disabled = true;
        fetchBtn.textContent = 'Fetching...';
        statusEl.innerHTML = '<span style="color:var(--text-sec)">Connecting to Azure DevOps...</span>';

        const result = await AzureDevOpsService.getWorkItemById(org, wiId);

        if (!result.ok) {
            fetchBtn.disabled = false;
            fetchBtn.textContent = 'Fetch and Analyze';
            statusEl.innerHTML = `<span style="color:var(--danger)">${this._escapeHtml(result.error || 'Unknown error')}</span>`;
            return;
        }

        const item = result.item;
        statusEl.innerHTML = `<span style="color:var(--success)">Fetched #${item.adoId}: "${this._escapeHtml((item.title || '').substring(0, 60))}..." — running analysis...</span>`;
        fetchBtn.textContent = 'Analyzing...';

        // Auto-fill the form fields (so it's visible in the form)
        document.getElementById('title').value = item.title;
        document.getElementById('description').value = item.description || '';
        document.getElementById('char-count').textContent = (item.description || '').length;
        document.getElementById('severity').value = item.severity || 'medium';

        // Try to match system
        const system = this._guessSystemFromText(item.title + ' ' + (item.description || '') + ' ' + (item.tags || ''));
        if (system) document.getElementById('system').value = system;

        // Set tags
        if (item.tags) {
            const tagStr = typeof item.tags === 'string' ? item.tags : item.tags.join(', ');
            document.getElementById('tags').value = tagStr;
        }

        // Build the ticket object (ready for analysis)
        const desc = item.description || item.title;
        const ticket = {
            id: 'TKT-' + Date.now(),
            adoId: item.adoId,
            adoUrl: item.adoUrl,
            title: item.title,
            desc: desc,
            description: desc,
            severity: item.severity || 'medium',
            system: system || '',
            tags: item.tags || '',
            timestamp: new Date().toISOString(),
            status: 'pending',
            source: 'ado-import'
        };

        // Run analysis (backend -> ollama -> local hybrid fallback)
        const backendEnabled = BackendRecommendationService.isEnabled();
        const ollamaEnabled = OllamaService.isEnabled();
        let analyzed = false;

        if (backendEnabled) {
            this._updateAnalyzeBtnLabel('Querying Backend...');
            const backendResult = await this._runBackendAnalysis(ticket, null);
            analyzed = backendResult.ok;
            if (!analyzed) {
                this._showToast(`Backend did not return a confident patch: ${backendResult.error}. Falling back.`, 'info');
            }
        }

        if (!analyzed && ollamaEnabled) {
            this._updateAnalyzeBtnLabel('Running Ollama analysis...');
            try {
                const ollamaResult = await OllamaService.recommend(ticket, PATCH_LIBRARY);
                if (ollamaResult.success) {
                    const recommendations = this._enrichOllamaRecommendationsForDebug(ollamaResult.recommendations);
                    const fullText = ticket.title + ' ' + (ticket.description || '') + ' ' + (ticket.tags || '');
                    const similarIncidents = ollamaResult.similarIncidents?.length
                        ? ollamaResult.similarIncidents
                        : (recommendations.length === 0
                            ? PatchRecommender.findSimilarResolvedTickets(fullText, ticket.severity, ticket.system, 5)
                            : []);
                    ticket.recommendations = recommendations.map(r => r.patch.id);
                    ticket.similarIncidents = similarIncidents.map(m => m.ticket.id || m.ticket.adoId || m.ticket.externalId || 'unknown');
                    ticket.engine = 'ollama';
                    ticket.ollamaModel = OllamaService.getSettings().model;

                    FeedbackStore.saveTicket(ticket);
                    this.activeTicketId = ticket.id;
                    this.currentResults = recommendations;
                    this.currentSimilarIncidents = similarIncidents;

                    this._renderResults(ticket, recommendations, 'ollama', similarIncidents);
                    this._switchTab('results');
                    this._renderStats();
                    analyzed = true;
                } else {
                    this._showToast(`Ollama failed: ${ollamaResult.error}. Falling back to Hybrid engine.`, 'info');
                }
            } catch {
                this._showToast('Ollama error. Falling back to Hybrid engine.', 'info');
            }
        }

        if (!analyzed) {
            this._runTFIDFAnalysis(ticket, document.getElementById('analyze-btn'));
        }

        this._updateAnalyzeBtnLabel(null);
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch and Analyze';
        statusEl.innerHTML = `<span style="color:var(--success)">Analysis complete for #${item.adoId}. Check the Recommendations tab.</span>`;
    },

    _bindSearch() {
        document.getElementById('history-search').addEventListener('input', (e) => {
            this._renderHistory(e.target.value);
        });
    },

    _clearValidation() {
        document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
        document.querySelectorAll('.form-control').forEach(el => el.classList.remove('error'));
    },

    _validate() {
        let valid = true;
        this._clearValidation();
        const title = document.getElementById('title').value.trim();
        const desc = document.getElementById('description').value.trim();
        const severity = document.getElementById('severity').value;

        if (!title) {
            document.getElementById('title-error').textContent = 'Ticket title is required';
            document.getElementById('title').classList.add('error');
            valid = false;
        }
        if (desc.length < 30) {
            document.getElementById('desc-error').textContent = 'Description must be at least 30 characters';
            document.getElementById('description').classList.add('error');
            valid = false;
        }
        if (!severity) {
            document.getElementById('severity-error').textContent = 'Please select a severity';
            document.getElementById('severity').classList.add('error');
            valid = false;
        }
        return valid;
    },

    async _analyzeTicket() {
        if (!this._requireIntegrationReady(true)) return;
        if (!this._validate()) return;

        const title = document.getElementById('title').value.trim();
        const desc = document.getElementById('description').value.trim();
        const severity = document.getElementById('severity').value;
        const system = document.getElementById('system').value;
        const tags = document.getElementById('tags').value.trim();

        const ticket = {
            id: 'TKT-' + Date.now(),
            title,
            desc,
            description: desc,
            severity,
            system,
            tags,
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        // Show loading state
        const btn = document.getElementById('analyze-btn');
        btn.classList.add('loading');
        btn.disabled = true;

        const backendEnabled = BackendRecommendationService.isEnabled();
        const ollamaEnabled = OllamaService.isEnabled();
        let analyzed = false;

        if (backendEnabled) {
            this._updateAnalyzeBtnLabel('Querying Backend...');
            const backendResult = await this._runBackendAnalysis(ticket, btn);
            analyzed = backendResult.ok;
            if (!analyzed) {
                this._showToast(`Backend did not return a confident patch: ${backendResult.error}. Falling back.`, 'info');
            }
        }

        if (!analyzed && ollamaEnabled) {
            this._updateAnalyzeBtnLabel('Running Ollama analysis...');
            try {
                const result = await OllamaService.recommend(ticket, PATCH_LIBRARY);
                if (result.success) {
                    const recommendations = this._enrichOllamaRecommendationsForDebug(result.recommendations);
                    const fullText = ticket.title + ' ' + (ticket.description || '') + ' ' + (ticket.tags || '');
                    const similarIncidents = result.similarIncidents?.length
                        ? result.similarIncidents
                        : (recommendations.length === 0
                            ? PatchRecommender.findSimilarResolvedTickets(fullText, ticket.severity, ticket.system, 5)
                            : []);
                    ticket.recommendations = recommendations.map(r => r.patch.id);
                    ticket.similarIncidents = similarIncidents.map(m => m.ticket.id || m.ticket.adoId || m.ticket.externalId || 'unknown');
                    ticket.engine = 'ollama';
                    ticket.ollamaModel = OllamaService.getSettings().model;

                    FeedbackStore.saveTicket(ticket);
                    this.activeTicketId = ticket.id;
                    this.currentResults = recommendations;
                    this.currentSimilarIncidents = similarIncidents;

                    this._renderResults(ticket, recommendations, 'ollama', similarIncidents);
                    this._switchTab('results');
                    this._renderStats();
                    btn.classList.remove('loading');
                    btn.disabled = false;
                    analyzed = true;
                } else {
                    this._showToast(`Ollama failed: ${result.error}. Falling back to Hybrid engine.`, 'info');
                }
            } catch {
                this._showToast('Ollama error. Falling back to Hybrid engine.', 'info');
            }
        }

        if (!analyzed) {
            setTimeout(() => this._runTFIDFAnalysis(ticket, btn), 350);
        } else {
            this._updateAnalyzeBtnLabel(null);
        }
    },

    async _runBackendAnalysis(ticket, btn = null) {
        const result = await BackendRecommendationService.recommend(ticket, PATCH_LIBRARY, {
            debug: this._isRecommendationDebugEnabled()
        });
        if (!result.success) return { ok: false, error: result.error || 'Backend call failed' };

        const recommendations = this._isRecommendationDebugEnabled()
            ? (result.recommendations || [])
            : (result.recommendations || []).map(r => ({ ...r, debug: null }));
        const fullText = ticket.title + ' ' + (ticket.description || '') + ' ' + (ticket.tags || '');
        const similarIncidents = result.similarIncidents?.length
            ? result.similarIncidents
            : (recommendations.length === 0
                ? PatchRecommender.findSimilarResolvedTickets(fullText, ticket.severity, ticket.system, 5)
                : []);

        // If backend abstains or cannot map any patch, force fallback to local engines.
        if (!recommendations.length) {
            return {
                ok: false,
                abstained: true,
                error: result.abstainReason || 'Backend could not find a confident patch match.'
            };
        }

        ticket.recommendations = recommendations.map(r => r.patch.id);
        ticket.similarIncidents = similarIncidents.map(m => m.ticket.id || m.ticket.adoId || m.ticket.externalId || 'unknown');
        ticket.engine = 'backend';
        ticket.backendEngine = result.engine || 'hybrid-rag';
        ticket.backendAbstainReason = result.abstainReason || '';
        ticket.backendAbstained = !!result.abstained;

        FeedbackStore.saveTicket(ticket);
        this.activeTicketId = ticket.id;
        this.currentResults = recommendations;
        this.currentSimilarIncidents = similarIncidents;

        if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        this._renderResults(ticket, recommendations, 'backend', similarIncidents);
        this._switchTab('results');
        this._renderStats();
        if (ticket.backendAbstained && ticket.backendAbstainReason) {
            this._showToast(ticket.backendAbstainReason, 'info');
        }
        return { ok: true, result };
    },

    _runTFIDFAnalysis(ticket, btn) {
        const desc = ticket.desc || ticket.description || '';
        const fullText = ticket.title + ' ' + desc + ' ' + ticket.tags;
        const recommendations = PatchRecommender.recommend(
            fullText,
            ticket.severity,
            ticket.system,
            5,
            { debug: this._isRecommendationDebugEnabled() }
        );
        const similarIncidents = recommendations.length === 0
            ? PatchRecommender.findSimilarResolvedTickets(fullText, ticket.severity, ticket.system, 5)
            : [];

        ticket.recommendations = recommendations.map(r => r.patch.id);
        ticket.similarIncidents = similarIncidents.map(m => m.ticket.id || m.ticket.adoId || m.ticket.externalId || 'unknown');
        ticket.engine = 'tfidf';

        FeedbackStore.saveTicket(ticket);
        this.activeTicketId = ticket.id;
        this.currentResults = recommendations;
        this.currentSimilarIncidents = similarIncidents;

        if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        this._updateAnalyzeBtnLabel(null);
        this._renderResults(ticket, recommendations, 'tfidf', similarIncidents);
        this._switchTab('results');
        this._renderStats();
    },

    _updateAnalyzeBtnLabel(label) {
        const btn = document.getElementById('analyze-btn');
        if (label) {
            btn.dataset._origText = btn.innerHTML;
            btn.innerHTML = `<span>${label}</span>`;
        } else {
            btn.innerHTML = btn.dataset._origText || '<span>Analyze Recommendations</span>';
        }
    },

    _isRecommendationDebugEnabled() {
        return !!this.recommendationDebug;
    },

    _enrichOllamaRecommendationsForDebug(recommendations) {
        if (!this._isRecommendationDebugEnabled()) return recommendations;
        return (recommendations || []).map(rec => {
            const rawConfidence = Number(rec.confidence || 0);
            const adjustedConfidence = Number(rec.adjustedConfidence || rawConfidence);
            const feedbackBoost = FeedbackStore.getBoost(rec.patch.id);
            const feedbackStats = FeedbackStore.getStats(rec.patch.id);
            return {
                ...rec,
                debug: {
                    engine: 'ollama',
                    rawConfidence,
                    adjustedConfidence,
                    feedbackMultiplier: feedbackBoost,
                    positive: Number(feedbackStats.positive || 0),
                    negative: Number(feedbackStats.negative || 0)
                }
            };
        });
    },

    _formatDebugNumber(value, digits = 3) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '0';
        return n.toFixed(digits);
    },

    _renderRecommendationDebug(debug) {
        if (!debug || !this._isRecommendationDebugEnabled()) return '';

        if (debug.engine === 'ollama') {
            return `
          <div class="reco-debug-panel">
            <div class="reco-debug-title">🧪 Recommendation Debug</div>
            <div class="reco-debug-row">
              <span class="reco-debug-chip">LLM: ${this._escapeHtml(this._formatDebugNumber(debug.rawConfidence, 0))}%</span>
              <span class="reco-debug-chip">Adjusted: ${this._escapeHtml(this._formatDebugNumber(debug.adjustedConfidence, 0))}%</span>
              <span class="reco-debug-chip">Feedback x${this._escapeHtml(this._formatDebugNumber(debug.feedbackMultiplier, 2))}</span>
              <span class="reco-debug-chip">Votes +${this._escapeHtml(String(debug.positive || 0))} / -${this._escapeHtml(String(debug.negative || 0))}</span>
            </div>
          </div>`;
        }

        if (debug.engine === 'backend') {
            return `
          <div class="reco-debug-panel">
            <div class="reco-debug-title">🧪 Recommendation Debug</div>
            <div class="reco-debug-row">
              <span class="reco-debug-chip">Backend raw ${this._escapeHtml(this._formatDebugNumber(debug.rawConfidence, 0))}%</span>
              <span class="reco-debug-chip">Adjusted ${this._escapeHtml(this._formatDebugNumber(debug.adjustedConfidence, 0))}%</span>
              <span class="reco-debug-chip">Reranker ${this._escapeHtml(this._formatDebugNumber(debug.rerankerScore || 0, 4))}</span>
              <span class="reco-debug-chip">Feedback x${this._escapeHtml(this._formatDebugNumber(debug.feedbackMultiplier || 1, 2))}</span>
            </div>
          </div>`;
        }

        const topTerms = Array.isArray(debug.topTerms) && debug.topTerms.length
            ? debug.topTerms.map(t => `<span class="reco-debug-chip">${this._escapeHtml(t)}</span>`).join('')
            : '<span class="reco-debug-chip">no strong shared terms</span>';

        return `
      <div class="reco-debug-panel">
        <div class="reco-debug-title">🧪 Recommendation Debug</div>
        <div class="reco-debug-grid">
          <span class="reco-debug-chip">topSim ${this._escapeHtml(this._formatDebugNumber(debug.topSimilarity))}</span>
          <span class="reco-debug-chip">floor ${this._escapeHtml(this._formatDebugNumber(debug.similarityFloor))}</span>
          <span class="reco-debug-chip">avgSim ${this._escapeHtml(this._formatDebugNumber(debug.avgSimilarity))}</span>
          <span class="reco-debug-chip">support x${this._escapeHtml(this._formatDebugNumber(debug.supportBoost, 2))}</span>
          <span class="reco-debug-chip">signal x${this._escapeHtml(this._formatDebugNumber(debug.signalBoost, 2))}</span>
          <span class="reco-debug-chip">feedback x${this._escapeHtml(this._formatDebugNumber(debug.feedbackMultiplier, 2))}</span>
          <span class="reco-debug-chip">score ${this._escapeHtml(this._formatDebugNumber(debug.finalScore))}</span>
          <span class="reco-debug-chip">confidence ${this._escapeHtml(this._formatDebugNumber(debug.confidence, 0))}%</span>
        </div>
        <div class="reco-debug-row">
          ${topTerms}
        </div>
      </div>`;
    },

    _renderResults(ticket, recommendations, engine = 'tfidf', similarIncidents = []) {
        const panel = document.getElementById('results-panel');
        const severityConf = SEVERITY_CONFIG[ticket.severity];

        const topConf = recommendations[0]?.confidence || 0;
        const confColor = topConf >= 75 ? '#2ed573' : topConf >= 50 ? '#ffd32a' : '#ff6b35';

        const isOllama = engine === 'ollama';
        const isBackend = engine === 'backend';
        const corpusSize = getRecommendationCorpus().length;
        const topPatchName = recommendations[0]?.patch?.name
            ? this._escapeHtml(recommendations[0].patch.name)
            : 'N/A';
        const engineBadge = isBackend
            ? `<span class="engine-badge engine-badge--backend">Backend Hybrid RAG</span>`
            : (isOllama
                ? `<span class="engine-badge engine-badge--llm">Ollama · ${ticket.ollamaModel || 'LLM'}</span>`
                : `<span class="engine-badge engine-badge--tfidf">Hybrid BM25 + TF-IDF</span>`);

        const summaryText = isBackend
            ? (recommendations.length > 0
                ? `<strong>Backend Analysis Complete.</strong> Hybrid retrieval + reranking matched ${similarIncidents.length} similar incident${similarIncidents.length !== 1 ? 's' : ''}. Top match: <em>${topPatchName}</em>`
                : (similarIncidents.length > 0
                    ? `<strong>Backend Analysis Complete.</strong> ${this._escapeHtml(ticket.backendAbstainReason || 'Similar incidents found, but evidence is not strong enough for a single fix recommendation.')}`
                    : '<strong>Backend Analysis Complete.</strong> No strong match found. Try expanding your description or syncing more resolved tickets.'))
            : (isOllama
                ? (recommendations.length > 0
                    ? `<strong>LLM Analysis Complete.</strong> Phi-4/Ollama reasoned over ${PATCH_LIBRARY.length} available patches using contextual understanding. Top match: <em>${topPatchName}</em>`
                    : (similarIncidents.length > 0
                        ? `<strong>LLM Analysis Complete.</strong> No direct patch template was selected, but ${similarIncidents.length} similar resolved incident${similarIncidents.length !== 1 ? 's were' : ' was'} found.`
                        : '<strong>LLM Analysis Complete.</strong> No strong match found. Try expanding your description or sync more resolved tickets.'))
                : `<strong>NLP Analysis Complete.</strong> Matched against ${corpusSize} historical/synced tickets using hybrid BM25 + TF-IDF scoring. ${recommendations.length > 0 ? `Top match: <em>${topPatchName}</em> (${recommendations[0].matchCount} similar tickets found)` : (similarIncidents.length > 0 ? `No mapped patch template found, but ${similarIncidents.length} similar resolved incident${similarIncidents.length !== 1 ? 's were' : ' was'} found.` : 'No strong matches found. Try expanding your description or sync more resolved tickets.')}`);

        const similarIncidentSection = recommendations.length === 0 && similarIncidents.length > 0
            ? `
            <div class="matched-tickets" style="margin-top:1rem">
              <div class="matched-label">Similar resolved incidents:</div>
              ${similarIncidents.map(m => {
                const t = m.ticket || {};
                const id = this._escapeHtml(t.adoId || t.externalId || t.id || 'N/A');
                const title = this._escapeHtml((t.title || 'Untitled issue').substring(0, 90));
                const src = this._escapeHtml(t.sourceProvider || (t.source === 'azure-devops' ? 'Azure DevOps' : 'Local corpus'));
                const score = Math.round(m.similarity * 200);
                const patch = t.resolvedPatch ? ` · Patch: ${this._escapeHtml(t.resolvedPatch)}` : '';
                return `<div class="matched-ticket-chip">
                    <span class="matched-id">${id}</span>
                    <span class="matched-title">${title}</span>
                    <span class="matched-sim">${score}% match · ${src}${patch}</span>
                </div>`;
              }).join('')}
            </div>
            `
            : '';

        panel.innerHTML = `
      <div class="results-header">
        <div class="results-ticket-info">
          <div class="ticket-badge">
            <span class="ticket-id">${ticket.id}</span>
            <span class="severity-badge" style="background:${severityConf.color}20;color:${severityConf.color};border-color:${severityConf.color}40">
              ${severityConf.label}
            </span>
            ${engineBadge}
          </div>
          <h2 class="results-title">${this._escapeHtml(ticket.title)}</h2>
          <div class="results-meta">
            ${ticket.system ? `<span class="meta-chip">${this._escapeHtml(ticket.system)}</span>` : ''}
            <span class="meta-chip">${new Date(ticket.timestamp).toLocaleString()}</span>
            <span class="meta-chip">${recommendations.length} patches found</span>
            ${similarIncidents.length > 0 ? `<span class="meta-chip">${similarIncidents.length} similar incidents</span>` : ''}
          </div>
        </div>
        <div class="top-confidence-ring">
          <svg viewBox="0 0 80 80" class="ring-svg">
            <circle cx="40" cy="40" r="34" fill="none" stroke="#d9e4f1" stroke-width="6"/>
            <circle cx="40" cy="40" r="34" fill="none" stroke="${confColor}" stroke-width="6"
              stroke-dasharray="${2.13 * topConf} 213.7" stroke-linecap="round"
              transform="rotate(-90 40 40)" class="ring-progress"/>
          </svg>
          <div class="ring-label">
            <span class="ring-pct">${topConf}%</span>
            <span class="ring-sub">confidence</span>
          </div>
        </div>
      </div>

      <div class="analysis-summary">
        <div class="summary-icon">${isBackend ? 'B' : (isOllama ? 'L' : 'H')}</div>
        <div class="summary-text">${summaryText}</div>
      </div>

      <div class="patches-grid">
        ${recommendations.length === 0
                ? `<div class="no-results">
               <div class="no-results-icon">R</div>
               <p>No mapped patch template found for this issue yet.</p>
               ${similarIncidentSection}
             </div>`
                : recommendations.map((rec, idx) => this._renderPatchCard(rec, idx, ticket.id, engine)).join('')
            }
      </div>
    `;

        // Bind feedback buttons
        panel.querySelectorAll('.feedback-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const patchId = btn.dataset.patch;
                const isPositive = btn.dataset.vote === 'up';
                this._submitFeedback(patchId, isPositive, btn.closest('.patch-card'));
            });
        });

        // Bind copy step buttons
        panel.querySelectorAll('.copy-step-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.text).then(() => {
                    btn.textContent = 'Copied';
                    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
                }).catch(() => { });
            });
        });

        // Bind copy code buttons (for trained patch code snippets)
        panel.querySelectorAll('.copy-code-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.code).then(() => {
                    btn.textContent = 'Copied';
                    btn.style.color = 'var(--success)';
                    setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = ''; }, 2000);
                }).catch(() => { });
            });
        });

        // Bind expand toggles
        panel.querySelectorAll('.expand-steps-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const steps = btn.closest('.patch-card').querySelector('.steps-list');
                const isOpen = steps.classList.toggle('open');
                btn.textContent = isOpen ? 'Hide Resolution Steps' : 'Show Resolution Steps';
            });
        });
    },

    _renderPatchCard(rec, idx, ticketId, engine = 'tfidf') {
        const { patch, confidence, matchCount, matchedTickets, feedbackStats, reasoning, debug } = rec;
        const confColor = confidence >= 75 ? '#2ed573' : confidence >= 50 ? '#ffd32a' : '#ff6b35';
        const riskColors = { low: '#2ed573', medium: '#ffd32a', high: '#ff6b35' };
        const rankLabels = ['Top Match', 'Second Match', 'Third Match', 'Fourth Match', 'Fifth Match'];
        const isOllama = engine === 'ollama';
        const isTrained = patch.type === 'trained';

        // Build code section for trained patches
        const codeSection = isTrained && patch.codeSnippets?.length ? `
          <div class="code-snippet-section">
            <div class="code-snippet-header">
              <span class="code-snippet-label">Code Fix</span>
              ${patch.prId ? `<span class="ref-badge ref-badge--pr">PR #${patch.prId}${patch.repoName ? ' · ' + this._escapeHtml(patch.repoName) : ''}</span>` : ''}
              ${patch.referenceAdoId ? `<span class="ref-badge ref-badge--ado">Ref: ADO-#${patch.referenceAdoId}</span>` : ''}
            </div>
            ${patch.codeSnippets.map(cs => `
              <div class="code-snippet-file">
                <div class="code-snippet-filepath">
                  <span class="code-change-type">${this._escapeHtml(cs.changeType)}</span>
                  ${this._escapeHtml(cs.file)}
                  <button class="copy-code-btn" data-code="${this._escapeHtml(cs.snippet)}" title="Copy code">Copy</button>
                </div>
                <pre class="code-snippet-block">${this._escapeHtml(cs.snippet.substring(0, 800))}${cs.snippet.length > 800 ? '\n… (truncated)' : ''}</pre>
              </div>
            `).join('')}
          </div>` : '';

        // Reference badge for when ticket ID is in matchedTickets
        const trainedMatchBadge = !isTrained && matchedTickets?.some(m => m.ticket.adoId)
            ? matchedTickets.filter(m => m.ticket.adoId).map(m =>
                `<span class="ref-badge ref-badge--ado" style="font-size:0.7rem">Ref: ADO-#${m.ticket.adoId}</span>`
            ).join('')
            : '';

        return `
      <div class="patch-card ${idx === 0 ? 'patch-card--top' : ''}" data-patch-id="${patch.id}">
        <div class="patch-card-header">
          <div class="patch-rank">${rankLabels[idx] || `#${idx + 1}`}</div>
          <div class="patch-confidence-bar-wrap">
            <div class="patch-confidence-bar" style="width:${confidence}%;background:${confColor}"></div>
          </div>
          <span class="patch-confidence-label" style="color:${confColor}">${confidence}%</span>
        </div>

        <div class="patch-body">
          <div class="patch-meta-row">
            <h3 class="patch-name">${this._escapeHtml(patch.name)}</h3>
            <div class="patch-badges">
              <span class="risk-badge" style="color:${riskColors[patch.riskLevel]};border-color:${riskColors[patch.riskLevel]}40">
                ${patch.riskLevel} risk
              </span>
              <span class="time-badge">${patch.estimatedTime}</span>
              ${patch.restartRequired ? '<span class="restart-badge">Restart Required</span>' : ''}
              ${isTrained ? '<span class="trained-badge">Trained from ADO</span>' : ''}
            </div>
          </div>

          ${reasoning ? `
          <div class="llm-reasoning">
            <span class="llm-reasoning-icon">${isOllama ? 'L' : 'R'}</span>
            <span class="llm-reasoning-text">${this._escapeHtml(reasoning)}</span>
          </div>` : ''}

          <p class="patch-description">${this._escapeHtml(patch.description)}</p>

          <div class="patch-stats-row">
            ${!isOllama ? `<span class="stat-chip">${matchCount} similar ticket${matchCount !== 1 ? 's' : ''}</span>` : ''}
            ${feedbackStats && feedbackStats.positive + feedbackStats.negative > 0
                ? `<span class="stat-chip">${feedbackStats.positive} helpful · ${feedbackStats.negative} not helpful</span>`
                : ''}
            ${trainedMatchBadge}
          </div>

          ${this._renderRecommendationDebug(debug)}

          ${codeSection}

          ${!isTrained && !isOllama && matchedTickets && matchedTickets.length > 0 ? `
          <div class="matched-tickets">
            <div class="matched-label">Similar resolved tickets:</div>
            ${matchedTickets.map(m => `
              <div class="matched-ticket-chip">
                <span class="matched-id">${m.ticket.id || m.ticket.adoId}</span>
                <span class="matched-title">${this._escapeHtml(m.ticket.title.substring(0, 55))}...</span>
                <span class="matched-sim">${Math.round(m.similarity * 200)}% match</span>
              </div>
            `).join('')}
          </div>` : ''}

          ${isTrained && !codeSection ? `
          <button class="expand-steps-btn">Show Resolution Steps</button>
          <div class="steps-list">
            ${patch.steps.map((step, i) => `
              <div class="step-item">
                <span class="step-num">${i + 1}</span>
                <pre class="step-code multiline">${this._escapeHtml(step)}</pre>
                <button class="copy-step-btn" data-text="${this._escapeHtml(step)}" title="Copy">Copy</button>
              </div>
            `).join('')}
          </div>` : ''}

          ${!isTrained ? `
          <button class="expand-steps-btn">Show Resolution Steps</button>
          <div class="steps-list">
            ${patch.steps.map((step, i) => `
              <div class="step-item">
                <span class="step-num">${i + 1}</span>
                <code class="step-code">${this._escapeHtml(step)}</code>
                <button class="copy-step-btn" data-text="${this._escapeHtml(step)}" title="Copy">Copy</button>
              </div>
            `).join('')}
          </div>` : ''}
        </div>

        <div class="patch-footer">
          <div class="feedback-section">
            <span class="feedback-label">Was this helpful?</span>
            <button class="feedback-btn feedback-btn--up" data-patch="${patch.id}" data-vote="up"
              ${feedbackStats && feedbackStats.userVote === 'up' ? 'data-voted="true"' : ''}>
              Helpful
            </button>
            <button class="feedback-btn feedback-btn--down" data-patch="${patch.id}" data-vote="down">
              Not Helpful
            </button>
          </div>
          <button class="mark-resolved-btn" data-patch="${patch.id}" data-ticket="${ticketId}" onclick="UI._markResolved(this)">
            ✓ Mark as Resolved
          </button>
        </div>
      </div>
    `;
    },

    _submitFeedback(patchId, isPositive, cardEl) {
        FeedbackStore.recordFeedback(patchId, isPositive);
        BackendRecommendationService.recordFeedback(patchId, isPositive ? 'up' : 'down').catch(() => { });

        // Visual feedback
        const upBtn = cardEl.querySelector('[data-vote="up"]');
        const downBtn = cardEl.querySelector('[data-vote="down"]');
        upBtn.classList.toggle('feedback-btn--selected', isPositive);
        downBtn.classList.toggle('feedback-btn--selected', !isPositive);

        this._showToast(isPositive
            ? 'Positive feedback recorded. This patch will rank higher for similar issues.'
            : 'Feedback recorded. Recommendation weighting updated.', isPositive ? 'success' : 'info');
    },

    _markResolved(btn) {
        const ticketId = btn.dataset.ticket;
        const patchId = btn.dataset.patch;

        FeedbackStore.updateTicket(ticketId, (ticket) => ({
            ...ticket,
            status: 'resolved',
            resolvedWith: patchId,
            resolvedAt: new Date().toISOString()
        }));

        btn.textContent = 'Resolved';
        btn.disabled = true;
        btn.style.background = '#2ed57320';
        btn.style.borderColor = '#2ed57360';
        btn.style.color = '#2ed573';

        FeedbackStore.recordFeedback(patchId, true);
        BackendRecommendationService.recordFeedback(patchId, 'up').catch(() => { });
        this._showToast('Ticket marked as resolved. Patch effectiveness logged.', 'success');
        this._renderStats();
        this._renderHistory();
    },

    _clearHistoryOnly() {
        FeedbackStore.clearAll();
        this.currentResults = [];
        this.currentSimilarIncidents = [];
        this.activeTicketId = null;
        this._renderHistory();
        this._renderStats();
        this._showToast('Ticket history and feedback cleared.', 'info');
    },

    _factoryResetAllData() {
        const confirmed = window.confirm(
            'Factory reset will delete all local history, training corpus, synced/imported tickets, profiles, and engine settings. Continue?'
        );
        if (!confirmed) return;

        // Drop in-memory trained patches before clearing stores.
        PATCH_LIBRARY
            .filter(p => p.type === 'trained')
            .map(p => p.id)
            .forEach(patchId => this._removePatchById(patchId));

        // Remove all app-owned localStorage keys.
        const exactKeys = new Set([
            'az_ollama_settings',
            'az_recommendation_settings',
            'azpatch_training_corpus'
        ]);
        const prefixes = ['azpatch_'];
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (!key) continue;
                if (exactKeys.has(key) || prefixes.some(prefix => key.startsWith(prefix))) {
                    safeRemoveLocalStorage(key);
                }
            }
        } catch {
            // If iteration fails due to browser restrictions, fall back to known keys only.
            exactKeys.forEach(k => safeRemoveLocalStorage(k));
        }

        FeedbackStore.setOrgNamespace('default');

        // Reset runtime UI state.
        this.activeTicketId = null;
        this.currentResults = [];
        this.currentSimilarIncidents = [];
        this.activeIntegrationProfileId = null;
        this.recommendationDebug = false;

        const ticketForm = document.getElementById('ticket-form');
        if (ticketForm) ticketForm.reset();
        const desc = document.getElementById('description');
        if (desc) desc.value = '';
        const charCount = document.getElementById('char-count');
        if (charCount) charCount.textContent = '0';

        this._clearValidation();
        this._initOllamaState();
        if (typeof this._refreshIntegrationSettings === 'function') this._refreshIntegrationSettings();
        this._updateTicketSourceIndicator();
        this._renderHistory();
        this._renderStats();
        this._renderTrainedList();
        this._switchTab('submit');

        const panel = document.getElementById('results-panel');
        if (panel) {
            panel.innerHTML = `
              <div class="no-results">
                <div class="no-results-icon">R</div>
                <p>Factory reset complete. Submit or import a ticket to start learning again.</p>
              </div>`;
        }

        this._showToast('Factory reset complete. Learning state is now clean.', 'success');
    },

    _renderHistory(searchQuery = '') {
        const container = document.getElementById('history-list');
        const history = FeedbackStore.getHistory();
        const allTickets = [...history];

        const filtered = searchQuery
            ? allTickets.filter(t =>
                t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                t.severity?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                t.system?.toLowerCase().includes(searchQuery.toLowerCase())
            )
            : allTickets;

        if (filtered.length === 0) {
            container.innerHTML = `
        <div class="history-empty">
          <div style="font-size:3rem;margin-bottom:1rem">R</div>
          <p>${searchQuery ? 'No tickets match your search.' : 'No tickets submitted yet. Analyze your first ticket!'}</p>
        </div>`;
            return;
        }

        container.innerHTML = filtered.map(ticket => {
            const sev = SEVERITY_CONFIG[ticket.severity] || SEVERITY_CONFIG.medium;
            const date = new Date(ticket.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const safeTicketId = this._escapeJsString(ticket.id);
            return `
        <div class="history-item" onclick="UI._viewHistoryTicket('${safeTicketId}')">
          <div class="history-item-left">
            <span class="history-id">${this._escapeHtml(ticket.id)}</span>
            <div class="history-title">${this._escapeHtml(ticket.title)}</div>
            <div class="history-meta">
              ${ticket.system ? `<span>${this._escapeHtml(ticket.system)}</span> · ` : ''}
              <span>${date}</span>
              ${ticket.recommendations?.length ? ` · ${ticket.recommendations.length} patch${ticket.recommendations.length !== 1 ? 'es' : ''} suggested` : ''}
            </div>
          </div>
          <div class="history-item-right">
            <span class="severity-badge" style="background:${sev.color}20;color:${sev.color};border-color:${sev.color}40">${sev.label}</span>
            <span class="status-badge status-badge--${ticket.status || 'pending'}">${ticket.status === 'resolved' ? 'Resolved' : 'Pending'}</span>
          </div>
        </div>
      `;
        }).join('');
    },

    _viewHistoryTicket(ticketId) {
        // Prefill form with historical ticket data for re-analysis
        const history = FeedbackStore.getHistory();
        const ticket = history.find(t => t.id === ticketId);
        if (!ticket) return;
        const description = ticket.desc || ticket.description || '';

        document.getElementById('title').value = ticket.title;
        document.getElementById('description').value = description;
        document.getElementById('severity').value = ticket.severity || '';
        document.getElementById('system').value = ticket.system || '';
        document.getElementById('tags').value = Array.isArray(ticket.tags) ? ticket.tags.join(', ') : (ticket.tags || '');
        document.getElementById('char-count').textContent = description.length;

        this._switchTab('submit');
        this._showToast('Ticket loaded into form. Click Analyze to re-run recommendations.', 'info');
    },

    _renderStats() {
        const summary = Analytics.getResolutionTimeSummary();
        const history = FeedbackStore.getHistory();
        const trainedCount = TrainingStore.count();
        const patchCount = trainedCount; // 1 patch per trained ticket

        const els = {
            'stat-total': summary.total,
            'stat-resolved': summary.resolved,
            'stat-resolution': summary.resolutionRate + '%',
            'stat-userqueue': history.filter(t => t.status !== 'resolved').length,
            'stat-trained': trainedCount,
            'stat-patchcount': patchCount
        };

        Object.entries(els).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) this._animateCount(el, val);
        });

        // Also update analytics KPI cards if present
        const kpiTrained = document.getElementById('kpi-trained');
        const kpiPatches = document.getElementById('kpi-patches');
        if (kpiTrained) this._animateCount(kpiTrained, trainedCount);
        if (kpiPatches) this._animateCount(kpiPatches, patchCount);
    },

    _animateCount(el, target) {
        const isPercent = typeof target === 'string' && target.includes('%');
        const num = parseInt(target);
        const suffix = isPercent ? '%' : '';
        let start = 0, dur = 600, startTime = null;

        const step = (ts) => {
            if (!startTime) startTime = ts;
            const prog = Math.min((ts - startTime) / dur, 1);
            el.textContent = Math.round(start + (num - start) * prog) + suffix;
            if (prog < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    },

    _renderCharts() {
        ChartManager.renderPatchUsageChart('chart-usage');
        ChartManager.renderSeverityChart('chart-severity');
        ChartManager.renderSystemChart('chart-systems');
        ChartManager.renderSuccessRateChart('chart-success');
    },

    _setupThemeParticles() {
        const canvas = document.getElementById('bg-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const dots = Array.from({ length: 50 }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.5 + 0.5,
            dx: (Math.random() - 0.5) * 0.3,
            dy: (Math.random() - 0.5) * 0.3,
            alpha: Math.random() * 0.4 + 0.1
        }));

        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            dots.forEach(d => {
                ctx.beginPath();
                ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(57,118,232,${d.alpha * 0.45})`;
                ctx.fill();
                d.x += d.dx; d.y += d.dy;
                if (d.x < 0 || d.x > canvas.width) d.dx *= -1;
                if (d.y < 0 || d.y > canvas.height) d.dy *= -1;
            });
            requestAnimationFrame(draw);
        };
        draw();

        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    },

    _showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        const msg = document.createElement('span');
        msg.textContent = message;
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => toast.remove());
        toast.appendChild(msg);
        toast.appendChild(closeBtn);
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('toast--visible'), 10);
        setTimeout(() => {
            toast.classList.remove('toast--visible');
            setTimeout(() => toast.remove(), 300);
        }, 4500);
    },

    _escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    _escapeJsString(str) {
        return String(str)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
    },

    // ─────────────────────────────────────────
    //  TRAIN TAB METHODS
    // ─────────────────────────────────────────
    _trainFetchedItem: null,
    _trainFetchedPR: null,
    _trainFetchedChanges: null,
    _trainFetchedCodePatches: null,   // [{ path, content, changeType }] — DB-related files only

    _initTrainTab() {
        const fetchBtn = document.getElementById('train-fetch-btn');
        const addBtn = document.getElementById('train-add-btn');
        const clearBtn = document.getElementById('train-clear-btn');
        const bulkBtn = document.getElementById('train-bulk-btn');

        if (fetchBtn) fetchBtn.addEventListener('click', () => this._fetchTrainTicket());
        if (addBtn) addBtn.addEventListener('click', () => this._addToTraining());
        if (bulkBtn) bulkBtn.addEventListener('click', () => this._bulkTrainByCreators());
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (confirm('Clear all trained tickets from the corpus?')) {
                const trained = TrainingStore.getAll();
                trained.forEach(t => this._removePatchById(t.resolvedPatch));
                if (!TrainingStore.clear()) {
                    this._showToast('Could not clear training corpus (storage error).', 'info');
                    return;
                }
                this._renderTrainedList();
                this._renderStats();
                this._showToast('Training corpus cleared.', 'info');
            }
        });

        this._renderTrainedList();
    },

    _removePatchById(patchId) {
        if (!patchId) return;
        const idx = PATCH_LIBRARY.findIndex(p => p.id === patchId && p.type === 'trained');
        if (idx !== -1) PATCH_LIBRARY.splice(idx, 1);
    },

    _removeTrainingTicket(ticketKey) {
        const key = String(ticketKey);
        const all = TrainingStore.getAll();
        const ticket = all.find(t => String(t.adoId || t.id) === key);
        if (!TrainingStore.remove(key)) {
            this._showToast('Could not remove item (storage error).', 'info');
            return;
        }
        if (ticket?.resolvedPatch) this._removePatchById(ticket.resolvedPatch);
        this._renderTrainedList();
        this._renderStats();
        this._showToast('Removed from training', 'info');
    },

    _populateTrainProfileSelect() {
        const sel = document.getElementById('train-profile-select');
        if (!sel || typeof TicketIntegrations === 'undefined') return;

        const profiles = TicketIntegrations.listProfiles();
        const activeId = TicketIntegrations.getActiveProfileId();

        sel.innerHTML = profiles.length === 0
            ? '<option value="">— No profiles saved (configure in Settings) —</option>'
            : profiles.map(p => {
                const provider = TicketIntegrations.getProvider(p.provider);
                const id = this._escapeHtml(p.id);
                const name = this._escapeHtml(p.name);
                const providerLabel = this._escapeHtml(provider?.label || p.provider);
                return `<option value="${id}" ${p.id === activeId ? 'selected' : ''}>${name} (${providerLabel})</option>`;
            }).join('');
    },

    _parseCreatorEmails(raw) {
        return Array.from(new Set(
            String(raw || '')
                .split(/[\n,;\s]+/g)
                .map(e => e.trim().toLowerCase())
                .filter(e => e && e.includes('@'))
        ));
    },

    _isLikelyCodeFile(path) {
        const p = String(path || '').toLowerCase();
        if (!p) return false;

        const fileName = p.split('/').pop() || p;
        const codeFileNames = new Set([
            'dockerfile', 'makefile', 'jenkinsfile', 'rakefile', 'procfile'
        ]);
        if (codeFileNames.has(fileName)) return true;

        const binaryExtensions = [
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
            '.pdf', '.zip', '.tar', '.gz', '.7z', '.jar', '.war',
            '.dll', '.so', '.dylib', '.exe', '.bin', '.class', '.pyc',
            '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov'
        ];
        if (binaryExtensions.some(ext => p.endsWith(ext))) return false;

        const docExtensions = [
            '.md', '.rst', '.txt', '.adoc', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'
        ];
        if (docExtensions.some(ext => p.endsWith(ext))) return false;

        const codeExtensions = [
            '.sql', '.ddl', '.dml', '.psql',
            '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
            '.py', '.java', '.cs', '.go', '.rb', '.php', '.scala',
            '.kt', '.kts', '.swift', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp',
            '.sh', '.bash', '.zsh', '.ps1', '.bat',
            '.yaml', '.yml', '.json', '.xml', '.toml', '.ini', '.cfg', '.conf',
            '.tf', '.tfvars', '.hcl',
            '.vue', '.svelte', '.html', '.css', '.scss', '.less'
        ];
        if (codeExtensions.some(ext => p.endsWith(ext))) return true;

        if (
            p.includes('/migrations/')
            || p.includes('/migration/')
            || p.includes('/schema/')
            || p.includes('/scripts/')
            || p.includes('/src/')
            || p.includes('/db/')
            || p.includes('/database/')
        ) {
            return true;
        }

        return false;
    },

    _summarizeBulkCodeSkipReasons(reasonCounts = {}) {
        const labels = {
            invalid: 'invalid work item payload',
            wi_lookup_failed: 'failed to load work item relations',
            no_linked_pr: 'no linked PR',
            pr_lookup_failed: 'could not read linked PR details',
            no_completed_pr: 'linked PR not completed',
            no_repo: 'missing repository context on PR',
            pr_changes_failed: 'failed to fetch PR changed files',
            no_changed_files: 'PR had no changed files',
            no_code_files: 'changed files were not code files',
            no_commit_context: 'missing PR commit context',
            no_code_content: 'code files found but content not retrievable',
            already_code_trained: 'already code-trained',
            storage_error: 'local storage update failed',
            duplicate_entry: 'duplicate training entry'
        };

        return Object.entries(reasonCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([reason, count]) => `${labels[reason] || reason}: ${count}`)
            .join(' · ');
    },

    _purgeNonCodeTrainingEntries() {
        const all = TrainingStore.getAll();
        let removed = 0;
        all.forEach(t => {
            const codeCount = Array.isArray(t.codeSnippets)
                ? t.codeSnippets.length
                : Number(t.codeFiles || 0);
            if (codeCount > 0) return;

            const key = String(t.adoId || t.id || '');
            if (!key) return;
            if (t.resolvedPatch) this._removePatchById(t.resolvedPatch);
            if (TrainingStore.remove(key)) removed++;
        });
        return removed;
    },

    async _resolveCompletedPrForWorkItem(org, item) {
        const wiResult = await AzureDevOpsService.getWorkItemById(org, item.adoId, { includeComments: false });
        if (!wiResult.ok) return { ok: false, reason: 'wi_lookup_failed', error: wiResult.error || 'work item lookup failed' };

        const linkedPRs = wiResult.item?.linkedPRs || [];
        if (!linkedPRs.length) return { ok: false, reason: 'no_linked_pr' };

        const completed = [];
        let detailsFetched = 0;
        for (const link of linkedPRs.slice(0, 8)) {
            const details = await AzureDevOpsService.getPullRequestDetails(org, link.prId);
            if (!details.ok || !details.pr) continue;
            detailsFetched++;
            if (String(details.pr.status || '').toLowerCase() === 'completed') {
                completed.push({ pr: details.pr, link });
            }
        }

        if (!detailsFetched) return { ok: false, reason: 'pr_lookup_failed' };
        if (!completed.length) return { ok: false, reason: 'no_completed_pr' };

        completed.sort((a, b) => {
            const aDate = new Date(a.pr.closedDate || a.pr.createdDate || 0).getTime();
            const bDate = new Date(b.pr.closedDate || b.pr.createdDate || 0).getTime();
            return bDate - aDate;
        });

        return { ok: true, pr: completed[0].pr, link: completed[0].link };
    },

    async _extractPrCodeSnippets(org, repoId, prId) {
        const changesResult = await AzureDevOpsService.getPullRequestChanges(org, repoId, prId);
        if (!changesResult.ok) return { ok: false, reason: 'pr_changes_failed', error: changesResult.error || 'could not fetch PR changes' };

        const changes = Array.isArray(changesResult.changes) ? changesResult.changes : [];
        if (!changes.length) return { ok: false, reason: 'no_changed_files' };

        const codeFiles = changes.filter(c => this._isLikelyCodeFile(c.path)).slice(0, 15);
        if (!codeFiles.length) return { ok: false, reason: 'no_code_files' };

        if (!changesResult.mergeCommitId) return { ok: false, reason: 'no_commit_context' };

        const codeSnippets = [];
        for (const cf of codeFiles) {
            const contentResult = await AzureDevOpsService.getFileContentAtCommit(
                org,
                repoId,
                cf.path,
                changesResult.mergeCommitId
            );
            if (!contentResult.ok) continue;
            const snippet = String(contentResult.content || '').trim();
            if (snippet.length < 20) continue;

            codeSnippets.push({
                file: cf.path,
                snippet: snippet.substring(0, 1200),
                changeType: cf.changeType || 'Edit'
            });
        }

        if (!codeSnippets.length) return { ok: false, reason: 'no_code_content' };

        return {
            ok: true,
            codeSnippets,
            changes,
            mergeCommitId: changesResult.mergeCommitId
        };
    },

    async _trainOneResolvedItemWithCode(item, org) {
        if (!item?.adoId) return { ok: false, reason: 'invalid' };

        try {
            const prResolve = await this._resolveCompletedPrForWorkItem(org, item);
            if (!prResolve.ok) return prResolve;

            const pr = prResolve.pr;
            const link = prResolve.link;
            const repoId = link?.repoId || pr.repoId;
            if (!repoId) return { ok: false, reason: 'no_repo' };

            const codeResult = await this._extractPrCodeSnippets(org, repoId, pr.prId);
            if (!codeResult.ok) return codeResult;

            const existing = TrainingStore.getAll().find(t => String(t.adoId || t.id) === String(item.adoId));
            let replacedOldNoCode = false;
            if (existing) {
                const existingCodeCount = Array.isArray(existing.codeSnippets)
                    ? existing.codeSnippets.length
                    : Number(existing.codeFiles || 0);
                if (existingCodeCount > 0) return { ok: false, reason: 'already_code_trained' };

                const existingKey = String(existing.adoId || existing.id || '');
                if (existing.resolvedPatch) this._removePatchById(existing.resolvedPatch);
                if (!TrainingStore.remove(existingKey)) return { ok: false, reason: 'storage_error' };
                replacedOldNoCode = true;
            }

            const codeSnippets = codeResult.codeSnippets;
            const changes = codeResult.changes;
            const tagsRaw = item.tags || '';
            const tagArray = normalizeTagArray(tagsRaw);
            const patchId = `PTRAIN-ADO-${item.adoId}-PR-${pr.prId}`;
            const codePaths = codeSnippets.map(s => s.file);

            let resolutionDesc = `Completed PR #${pr.prId}: ${pr.title || `Task ${item.adoId} fix`}`;
            if (pr.description) resolutionDesc += `\n${String(pr.description).trim().substring(0, 1200)}`;
            resolutionDesc += `\nCode files: ${codePaths.slice(0, 10).join(', ')}${codePaths.length > 10 ? ' ...' : ''}`;

            const mapping = {
                workItemId: item.adoId,
                workItemUrl: item.adoUrl || '',
                prId: pr.prId,
                prUrl: pr.url || '',
                repoId,
                repoName: pr.repoName || '',
                mergeCommitId: codeResult.mergeCommitId || '',
                files: codePaths
            };

            const patchPayload = {
                id: patchId,
                name: `Code Fix: ${String(pr.title || item.title || `Task #${item.adoId}`).substring(0, 60)}`,
                type: 'trained',
                description: resolutionDesc.substring(0, 500),
                riskLevel: 'medium',
                estimatedTime: 'Varies',
                restartRequired: false,
                tags: tagArray,
                steps: codeSnippets.map(cs => `// ${cs.changeType}: ${cs.file}\n${cs.snippet.substring(0, 600)}`),
                codeSnippets,
                referenceAdoId: item.adoId,
                prId: pr.prId,
                prUrl: pr.url || null,
                repoName: pr.repoName || null,
                sourceMapping: mapping
            };

            const existingPatchIdx = PATCH_LIBRARY.findIndex(p => p.id === patchId);
            if (existingPatchIdx >= 0) PATCH_LIBRARY[existingPatchIdx] = { ...PATCH_LIBRARY[existingPatchIdx], ...patchPayload };
            else PATCH_LIBRARY.push(patchPayload);

            const trainingTicket = {
                id: `TRAIN-ADO-${item.adoId}-PR-${pr.prId}`,
                adoId: item.adoId,
                adoUrl: item.adoUrl || '',
                title: item.title || `ADO #${item.adoId}`,
                description: item.description || '',
                severity: item.severity || 'medium',
                system: this._guessSystemFromText(
                    `${item.title || ''} ${item.description || ''} ${tagsRaw} ${codeSnippets.map(s => s.snippet).join(' ')}`
                ),
                tags: tagArray,
                resolvedPatch: patchId,
                resolutionDescription: resolutionDesc,
                codeSnippets,
                outcome: 'resolved',
                status: 'resolved',
                resolutionTime: 2,
                feedbackRating: 4,
                trainedAt: new Date().toISOString(),
                source: 'azure-devops-bulk-code',
                hasPR: true,
                prId: pr.prId,
                prUrl: pr.url || '',
                repoName: pr.repoName || '',
                changedFiles: changes.length,
                codeFiles: codeSnippets.length,
                createdBy: item.createdBy || '',
                createdByEmail: item.createdByEmail || '',
                mapping
            };

            const addResult = TrainingStore.add(trainingTicket);
            if (!addResult.ok) {
                if (addResult.error === 'Ticket already in training corpus') return { ok: false, reason: 'duplicate_entry' };
                if (existingPatchIdx < 0) this._removePatchById(patchId);
                return { ok: false, reason: 'storage_error' };
            }

            return {
                ok: true,
                codeFiles: codeSnippets.length,
                changedFiles: changes.length,
                prId: pr.prId,
                replacedOldNoCode
            };
        } catch (err) {
            return { ok: false, reason: 'internal_error', error: err?.message || 'unknown error' };
        }
    },

    async _bulkTrainByCreators() {
        const profileId = document.getElementById('train-profile-select')?.value;
        const statusEl = document.getElementById('train-bulk-status');
        const bulkBtn = document.getElementById('train-bulk-btn');
        const emailsRaw = document.getElementById('train-created-by-emails')?.value || '';
        const limitRaw = document.getElementById('train-bulk-limit')?.value;

        const creatorEmails = this._parseCreatorEmails(emailsRaw);
        const limit = Math.max(1, Math.min(2000, parseInt(limitRaw || '200', 10) || 200));

        if (!creatorEmails.length) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Enter at least one valid creator email ID.</span>';
            return;
        }
        if (!profileId) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Select an integration profile first (configure in Settings).</span>';
            return;
        }

        const profile = TicketIntegrations.getProfile(profileId);
        if (!profile) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Profile not found.</span>';
            return;
        }
        if (profile.provider !== 'azure' || !profile.config?.orgUrl || !profile.config?.project || !profile.config?.pat) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Selected profile is not ready for Azure fetch. Open Settings and enter org/project/PAT.</span>';
            return;
        }

        const org = {
            orgUrl: profile.config.orgUrl,
            project: profile.config.project,
            pat: profile.config.pat,
            id: profile.id
        };

        bulkBtn.disabled = true;
        bulkBtn.textContent = 'Bulk Training...';
        statusEl.innerHTML = `<span style="color:var(--text-sec)">Fetching resolved tasks for ${creatorEmails.length} creator email(s)...</span>`;

        const fetchResult = await AzureDevOpsService.fetchWorkItems(org, {
            states: ['Resolved', 'Closed', 'Done'],
            types: ['Task'],
            creatorEmails,
            limit
        });

        if (!fetchResult.ok) {
            bulkBtn.disabled = false;
            bulkBtn.textContent = 'Bulk Train';
            statusEl.innerHTML = `<span style="color:var(--danger)">${this._escapeHtml(fetchResult.error || 'Bulk fetch failed')}</span>`;
            return;
        }

        const items = fetchResult.items || [];
        if (!items.length) {
            bulkBtn.disabled = false;
            bulkBtn.textContent = 'Bulk Train';
            const scannedCount = Number(fetchResult.meta?.scannedCount || 0);
            const wiqlTop = Number(fetchResult.meta?.wiqlTop || 0);
            statusEl.innerHTML = `<span style="color:var(--warning)">No resolved tasks found for these creators.${scannedCount > 0 ? ` Scanned ${scannedCount} items (WIQL top=${wiqlTop || scannedCount}).` : ''} Verify creator emails exactly match <em>Created By</em>, or increase Max Tickets.</span>`;
            return;
        }

        const removedNonCode = this._purgeNonCodeTrainingEntries();

        let added = 0;
        let skipped = 0;
        let replaced = 0;
        let codeFileCount = 0;
        const reasonCounts = {};

        for (let i = 0; i < items.length; i++) {
            if (i === 0 || (i + 1) % 5 === 0 || i === items.length - 1) {
                statusEl.innerHTML = `<span style="color:var(--text-sec)">Code-only training in progress: ${i + 1}/${items.length} task(s)...</span>`;
            }

            const result = await this._trainOneResolvedItemWithCode(items[i], org);
            if (result.ok) {
                added++;
                codeFileCount += Number(result.codeFiles || 0);
                if (result.replacedOldNoCode) replaced++;
            } else {
                skipped++;
                const reason = String(result.reason || 'unknown');
                reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
            }
        }

        this._renderTrainedList();
        this._renderStats();
        if (this.activeTab === 'analytics') this._renderCharts();

        bulkBtn.disabled = false;
        bulkBtn.textContent = 'Bulk Train';
        const scannedCount = Number(fetchResult.meta?.scannedCount || 0);
        const reasonSummary = this._summarizeBulkCodeSkipReasons(reasonCounts);
        const tone = added > 0 ? 'var(--success)' : 'var(--warning)';
        statusEl.innerHTML = `<span style="color:${tone}">Code-only bulk training complete. Fetched ${items.length} resolved task(s)${scannedCount > 0 ? ` from ${scannedCount} scanned` : ''} · Added ${added} · Replaced ${replaced} old non-code entries · Skipped ${skipped} · Code files learned ${codeFileCount}.${removedNonCode > 0 ? ` Purged ${removedNonCode} older non-code training entr${removedNonCode === 1 ? 'y' : 'ies'}.` : ''}${reasonSummary ? ` Skip reasons: ${this._escapeHtml(reasonSummary)}.` : ''}</span>`;
        this._showToast(`Code-only bulk training: ${added} added, ${skipped} skipped, ${codeFileCount} code files learned.`, added > 0 ? 'success' : 'info');
    },

    async _fetchTrainTicket() {
        const profileId = document.getElementById('train-profile-select')?.value;
        const wiIdRaw = document.getElementById('train-wi-id')?.value.trim();
        const statusEl = document.getElementById('train-fetch-status');
        const previewEl = document.getElementById('train-preview');
        const fetchBtn = document.getElementById('train-fetch-btn');
        const prStatusEl = document.getElementById('train-pr-status');
        const prInfoEl = document.getElementById('train-pr-info');
        const manualGroup = document.getElementById('train-manual-group');

        // Reset PR state
        this._trainFetchedPR = null;
        this._trainFetchedChanges = null;
        this._trainFetchedCodePatches = null;
        if (prInfoEl) { prInfoEl.style.display = 'none'; prInfoEl.innerHTML = ''; }
        if (prStatusEl) prStatusEl.innerHTML = '';
        if (manualGroup) manualGroup.style.display = 'block';

        // Parse work item ID (supports full URLs or plain numbers)
        let wiId = wiIdRaw;
        const urlMatch = wiIdRaw.match(/\/(\d+)\s*$/);
        if (urlMatch) wiId = urlMatch[1];
        wiId = parseInt(wiId);

        if (!wiId || isNaN(wiId)) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Enter a valid work item ID or URL</span>';
            return;
        }

        if (!profileId) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Select an integration profile first (configure in Settings)</span>';
            return;
        }

        const profile = TicketIntegrations.getProfile(profileId);
        if (!profile) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Profile not found</span>';
            return;
        }
        if (profile.provider !== 'azure' || !profile.config?.orgUrl || !profile.config?.project || !profile.config?.pat) {
            statusEl.innerHTML = '<span style="color:var(--danger)">Selected profile is not ready for Azure fetch. Open Settings and enter org/project/PAT.</span>';
            return;
        }

        // Build org object expected by AzureDevOpsService
        const org = {
            orgUrl: profile.config.orgUrl,
            project: profile.config.project,
            pat: profile.config.pat,
            id: profile.id
        };

        fetchBtn.disabled = true;
        fetchBtn.textContent = 'Fetching...';
        statusEl.innerHTML = '<span style="color:var(--text-sec)">Connecting to Azure DevOps...</span>';
        previewEl.innerHTML = '';
        previewEl.classList.remove('visible');

        const result = await AzureDevOpsService.getWorkItemById(org, wiId);

        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch Ticket';

        if (!result.ok) {
            statusEl.innerHTML = `<span style="color:var(--danger)">${this._escapeHtml(result.error || 'Unknown error')}</span>`;
            this._trainFetchedItem = null;
            return;
        }

        const item = result.item;
        this._trainFetchedItem = item;

        // Render ticket preview
        const sevColors = { critical: '#ff4757', high: '#ff6b35', medium: '#ffd32a', low: '#2ed573' };
        const sevCol = sevColors[item.severity] || '#ffd32a';
        const commentsHtml = item.comments?.length
            ? `<div class="train-comments">
                 <div class="train-comments-title">Comments (${item.comments.length})</div>
                 ${item.comments.slice(0, 5).map(c =>
                `<div class="train-comment"><strong>${this._escapeHtml(c.author)}</strong>: ${this._escapeHtml(c.text.substring(0, 200))}${c.text.length > 200 ? '…' : ''}</div>`
            ).join('')}
               </div>`
            : '';

        previewEl.innerHTML = `
            <div class="train-preview-card">
                <div class="train-preview-header">
                    <span class="train-preview-id">#${item.adoId}</span>
                    <span class="severity-badge" style="background:${sevCol}20;color:${sevCol};border-color:${sevCol}40">${item.severity?.toUpperCase()}</span>
                    <span class="train-preview-state">${item.state}</span>
                    <span class="train-preview-type">${item.type}</span>
                </div>
                <h3 class="train-preview-title">${this._escapeHtml(item.title)}</h3>
                <p class="train-preview-desc">${this._escapeHtml(item.description || 'No description available').substring(0, 800)}</p>
                <div class="train-preview-meta">
                    ${item.tags ? `<span>${this._escapeHtml(item.tags)}</span>` : ''}
                    <span>${this._escapeHtml(item.assignedTo)}</span>
                    <span>${this._escapeHtml(item.area)}</span>
                    ${item.createdDate ? `<span>${new Date(item.createdDate).toLocaleDateString()}</span>` : ''}
                </div>
                ${commentsHtml}
            </div>
        `;
        previewEl.classList.add('visible');

        statusEl.innerHTML = `<span style="color:var(--success)">Fetched work item #${item.adoId} successfully</span>`;

        // --- Auto-detect linked PRs ---
        if (item.linkedPRs && item.linkedPRs.length > 0) {
            prStatusEl.innerHTML = `<span style="color:var(--info)">Found ${item.linkedPRs.length} linked PR(s). Fetching details...</span>`;

            // Prefer a completed PR when multiple links exist
            let chosenPr = null;
            let chosenLink = null;
            for (const link of item.linkedPRs.slice(0, 5)) {
                const details = await AzureDevOpsService.getPullRequestDetails(org, link.prId);
                if (!details.ok) continue;
                if (!chosenPr) {
                    chosenPr = details.pr;
                    chosenLink = link;
                }
                if (details.pr.status === 'completed') {
                    chosenPr = details.pr;
                    chosenLink = link;
                    break;
                }
            }

            if (chosenPr) {
                this._trainFetchedPR = chosenPr;
                const pr = chosenPr;
                const prLink = chosenLink || item.linkedPRs[0];

                // Fetch file changes if we have a repo ID
                let changesHtml = '';
                const repoId = prLink.repoId || pr.repoId;
                if (repoId) {
                    const changesResult = await AzureDevOpsService.getPullRequestChanges(org, repoId, pr.prId);
                    if (changesResult.ok && changesResult.changes.length) {
                        this._trainFetchedChanges = changesResult.changes;

                        // ── Detect & fetch DB-related file content ──
                        const dbExtensions = ['.sql', '.ddl', '.dml'];
                        const dbKeywords = ['migration', 'migrate', 'patch', 'schema', '/db/', '/database/', 'flyway', 'liquibase', 'alembic', 'seed'];
                        const dbFiles = changesResult.changes.filter(c => {
                            const p = c.path.toLowerCase();
                            return dbExtensions.some(ext => p.endsWith(ext))
                                || dbKeywords.some(kw => p.includes(kw));
                        }).slice(0, 5);

                        if (dbFiles.length > 0 && changesResult.mergeCommitId) {
                            prStatusEl.innerHTML = `<span style="color:var(--info)">Extracting code from ${dbFiles.length} DB file(s)...</span>`;
                            const codePatches = [];
                            for (const dbFile of dbFiles) {
                                const contentResult = await AzureDevOpsService.getFileContentAtCommit(
                                    org, repoId, dbFile.path, changesResult.mergeCommitId
                                );
                                if (contentResult.ok && contentResult.content.trim()) {
                                    codePatches.push({
                                        path: dbFile.path,
                                        content: contentResult.content,
                                        changeType: dbFile.changeType
                                    });
                                }
                            }
                            this._trainFetchedCodePatches = codePatches.length ? codePatches : null;
                        }

                        const changeIcons = { 'Add': '+', 'Edit': '~', 'Delete': '-', 'Rename': '>' };
                        const codePreviewHtml = this._trainFetchedCodePatches?.length ? `
                            <div style="margin-top:0.75rem">
                                <div style="font-size:0.78rem;font-weight:700;color:var(--accent);margin-bottom:0.4rem">DB Code Detected (${this._trainFetchedCodePatches.length} file${this._trainFetchedCodePatches.length !== 1 ? 's' : ''})</div>
                                ${this._trainFetchedCodePatches.map(cp => `
                                    <div style="margin-bottom:0.6rem">
                                        <div style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-muted);margin-bottom:0.25rem">${this._escapeHtml(cp.path)}</div>
                                        <pre class="code-snippet-block">${this._escapeHtml(cp.content.substring(0, 600))}${cp.content.length > 600 ? '\n… (truncated)' : ''}</pre>
                                    </div>
                                `).join('')}
                            </div>` : '';

                        changesHtml = `
                            <div style="margin-top:0.75rem">
                                <div style="font-size:0.78rem;font-weight:600;color:var(--text-sec);margin-bottom:0.4rem">
                                    Changed Files (${changesResult.changes.length})
                                </div>
                                <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:0.5rem">
                                    ${changesResult.changes.map(c => {
                            const icon = changeIcons[c.changeType] || '~';
                            const isDb = c.path.match(/\.(sql|ddl|dml)$/i) || dbKeywords.some(kw => c.path.toLowerCase().includes(kw));
                            return `<div style="font-family:var(--font-mono);font-size:0.75rem;color:${isDb ? 'var(--accent)' : 'var(--text-sec)'};padding:0.2rem 0.4rem;border-radius:4px;margin-bottom:0.15rem;background:rgba(241,247,255,0.82)">
                                            ${icon} <span style="color:var(--text-muted);font-size:0.7rem">[${c.changeType}]</span> ${this._escapeHtml(c.path)}${isDb ? ' <span style="font-size:0.65rem;color:var(--accent)">● DB</span>' : ''}
                                        </div>`;
                        }).join('')}
                                </div>
                                ${codePreviewHtml}
                            </div>`;
                    }
                }

                // Show PR info card
                const statusBadge = pr.status === 'completed'
                    ? '<span style="background:rgba(46,213,115,0.15);color:var(--success);border:1px solid rgba(46,213,115,0.3);border-radius:99px;padding:0.15rem 0.6rem;font-size:0.72rem;font-weight:600">Completed</span>'
                    : pr.status === 'active'
                        ? '<span style="background:rgba(55,118,232,0.15);color:var(--accent);border:1px solid rgba(55,118,232,0.3);border-radius:99px;padding:0.15rem 0.6rem;font-size:0.72rem;font-weight:600">Active</span>'
                        : `<span style="background:rgba(242,247,255,0.9);color:var(--text-muted);border:1px solid var(--border);border-radius:99px;padding:0.15rem 0.6rem;font-size:0.72rem;font-weight:600">${this._escapeHtml(pr.status || 'unknown')}</span>`;

                const reviewersHtml = pr.reviewers?.length
                    ? pr.reviewers.map(r => {
                        const voteIcon = r.vote >= 10 ? 'approved' : r.vote >= 5 ? 'looks good' : r.vote <= -5 ? 'changes requested' : 'pending';
                        return `<span style="font-size:0.75rem;color:var(--text-muted)">${voteIcon} ${this._escapeHtml(r.name)}</span>`;
                    }).join(' · ')
                    : '';

                prInfoEl.innerHTML = `
                    <div style="background:rgba(55,118,232,0.06);border:1px solid rgba(55,118,232,0.2);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:0.75rem">
                        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap">
                            <span style="font-family:var(--font-mono);font-size:0.8rem;color:var(--accent);font-weight:700">PR #${pr.prId}</span>
                            ${statusBadge}
                            <span style="font-size:0.72rem;color:var(--text-muted)">${this._escapeHtml(pr.sourceBranch)} → ${this._escapeHtml(pr.targetBranch)}</span>
                        </div>
                        <div style="font-size:0.9rem;font-weight:700;color:var(--text-primary);margin-bottom:0.35rem">${this._escapeHtml(pr.title)}</div>
                        ${pr.description ? `<div style="font-size:0.8rem;color:var(--text-sec);margin-bottom:0.35rem;line-height:1.5">${this._escapeHtml(pr.description).substring(0, 400)}</div>` : ''}
                        <div style="font-size:0.75rem;color:var(--text-muted)">
                            ${this._escapeHtml(pr.createdBy)}
                            ${pr.repoName ? ` · ${this._escapeHtml(pr.repoName)}` : ''}
                            ${reviewersHtml ? ` · ${reviewersHtml}` : ''}
                        </div>
                        ${changesHtml}
                    </div>
                `;
                prInfoEl.style.display = 'block';

                const codeMsg = this._trainFetchedCodePatches?.length
                    ? ` · ${this._trainFetchedCodePatches.length} DB code file(s) extracted`
                    : (this._trainFetchedChanges?.length ? ' · No SQL/migration files detected — describe fix below' : '');
                if (pr.status === 'completed') {
                    prStatusEl.innerHTML = `<span style="color:var(--success)">PR #${pr.prId} linked${codeMsg}</span>`;
                } else {
                    prStatusEl.innerHTML = `<span style="color:var(--warning)">Linked PR #${pr.prId} is ${this._escapeHtml(pr.status)}. Add manual resolution details before training.</span>`;
                }

                // Hide manual text if PR is completed AND we extracted code
                if (pr.status === 'completed' && this._trainFetchedCodePatches?.length) {
                    manualGroup.style.display = 'none';
                }
            } else {
                prStatusEl.innerHTML = `<span style="color:var(--warning)">PR linked but couldn't fetch details. Describe the resolution manually below.</span>`;
            }
        } else {
            prStatusEl.innerHTML = `<span style="color:var(--text-muted)">No linked Pull Request found. Describe the resolution manually below.</span>`;
        }
    },

    _addToTraining() {
        if (!this._trainFetchedItem) {
            this._showToast('Fetch a ticket first before adding to training.', 'info');
            return;
        }

        const manualText = document.getElementById('train-resolution-text')?.value.trim();
        const hasCompletedPR = this._trainFetchedPR && this._trainFetchedPR.status === 'completed';
        const hasChanges = this._trainFetchedChanges && this._trainFetchedChanges.length > 0;
        const hasCode = this._trainFetchedCodePatches && this._trainFetchedCodePatches.length > 0;
        const hasUsablePRData = !!hasCompletedPR;

        // Need either a completed PR, or explicit manual resolution notes
        if (!hasUsablePRData && !manualText) {
            this._showToast('Add manual resolution details, or use a completed linked PR before training.', 'info');
            return;
        }

        const item = this._trainFetchedItem;
        const tagsRaw = item.tags || '';
        const tagArray = normalizeTagArray(tagsRaw);

        // Build resolution description
        let resolutionDesc = '';
        if (hasUsablePRData) {
            const pr = this._trainFetchedPR;
            resolutionDesc = `PR #${pr.prId}: ${pr.title}`;
            if (pr.description) resolutionDesc += `\n${pr.description}`;
            if (hasCode) {
                resolutionDesc += `\nCode changes: ${this._trainFetchedCodePatches.map(c => c.path).join(', ')}`;
            } else if (hasChanges) {
                resolutionDesc += `\nChanged files: ${this._trainFetchedChanges.map(c => `${c.changeType}: ${c.path}`).join(', ')}`;
            }
            if (manualText) resolutionDesc += `\nAdditional notes: ${manualText}`;
        } else {
            resolutionDesc = manualText;
        }

        // Build code-based patch steps — actual SQL/code content is primary now
        let patchSteps = [];
        if (hasCode) {
            // Each DB code file becomes a step with real content
            patchSteps = this._trainFetchedCodePatches.map(cp =>
                `// ${cp.changeType}: ${cp.path}\n${cp.content.substring(0, 600)}`
            );
        } else if (hasUsablePRData && hasChanges) {
            patchSteps = this._trainFetchedChanges.slice(0, 10).map(c => `${c.changeType}: ${c.path}`);
        } else {
            patchSteps = [manualText || 'Review the resolution description for details'];
        }

        // Build codeSnippets array for display in suggestions
        const codeSnippets = hasCode
            ? this._trainFetchedCodePatches.map(cp => ({
                file: cp.path,
                snippet: cp.content.substring(0, 1200),
                changeType: cp.changeType
            }))
            : [];

        // Create a dynamic custom patch from the resolution
        const customPatchId = 'PTRAIN-' + Date.now();
        const pr = hasUsablePRData ? this._trainFetchedPR : null;
        const customPatch = {
            id: customPatchId,
            name: hasUsablePRData
                ? `PR Fix: ${pr.title.substring(0, 60)}`
                : `Fix: ${item.title.substring(0, 60)}`,
            type: 'trained',
            description: resolutionDesc.substring(0, 500),
            riskLevel: 'medium',
            estimatedTime: 'Varies',
            restartRequired: false,
            tags: tagArray,
            steps: patchSteps,
            codeSnippets,                                   // NEW: actual SQL/code content
            referenceAdoId: item.adoId,                     // NEW: source ticket reference
            prId: hasUsablePRData ? pr.prId : null,
            prUrl: hasUsablePRData ? pr.url : null,
            repoName: hasUsablePRData ? pr.repoName : null
        };
        PATCH_LIBRARY.push(customPatch);

        // Build training ticket
        const trainingTicket = {
            id: `TRAIN-ADO-${item.adoId}`,
            adoId: item.adoId,
            adoUrl: item.adoUrl,
            title: item.title,
            description: item.description || '',
            severity: item.severity || 'medium',
            system: this._guessSystemFromText(
                item.title + ' ' + (item.description || '') + ' ' + tagsRaw +
                ' ' + codeSnippets.map(s => s.snippet).join(' ')  // include code in system detection
            ),
            tags: tagArray,
            resolvedPatch: customPatchId,
            resolutionDescription: resolutionDesc,
            // NEW: store code for vectorization + display
            codeSnippets,
            outcome: 'resolved',
            resolutionTime: 2,
            feedbackRating: 4,
            trainedAt: new Date().toISOString(),
            source: 'azure-devops',
            hasPR: !!hasUsablePRData,
            prId: hasUsablePRData ? pr.prId : null,
            changedFiles: hasUsablePRData && hasChanges ? this._trainFetchedChanges.length : 0,
            codeFiles: codeSnippets.length
        };

        const result = TrainingStore.add(trainingTicket);
        if (!result.ok) {
            this._showToast(result.error, 'info');
            return;
        }

        const codeLabel = codeSnippets.length ? ` with ${codeSnippets.length} DB code file(s)` : '';
        this._showToast(`Ticket #${item.adoId} added to training corpus${codeLabel}. The AI will now learn from this fix.`, 'success');
        this._renderTrainedList();
        this._renderStats();

        // Reset
        this._trainFetchedItem = null;
        this._trainFetchedPR = null;
        this._trainFetchedChanges = null;
        this._trainFetchedCodePatches = null;
        document.getElementById('train-preview').classList.remove('visible');
        document.getElementById('train-wi-id').value = '';
        document.getElementById('train-pr-info').style.display = 'none';
        document.getElementById('train-pr-info').innerHTML = '';
        document.getElementById('train-pr-status').innerHTML = '';
        document.getElementById('train-resolution-text').value = '';
        document.getElementById('train-manual-group').style.display = 'block';
    },

    _guessSystemFromText(text) {
        const normalized = normalizeSystemValue(text);
        const systemMap = {
            cosmos: 'Azure Cosmos DB',
            postgresql: 'Azure Database for PostgreSQL',
            mysql: 'Azure Database for MySQL',
            mariadb: 'Azure Database for MariaDB',
            'sql-managed-instance': 'Azure SQL Managed Instance',
            'sql-serverless': 'Azure SQL Serverless',
            'sql-elastic-pool': 'Azure SQL Elastic Pool',
            'sql-alwayson': 'SQL Server 2019 Always On',
            'azure-sql': 'Azure SQL Database',
            'sql-server': 'SQL Server 2019'
        };
        if (systemMap[normalized]) return systemMap[normalized];
        return '';
    },

    _renderTrainedList() {
        const container = document.getElementById('trained-list');
        const countEl = document.getElementById('trained-count');
        if (!container) return;

        const trained = TrainingStore.getAll();
        if (countEl) countEl.textContent = trained.length;

        if (trained.length === 0) {
            container.innerHTML = `
                <div class="train-empty">
                    <div style="font-size:2.5rem;margin-bottom:0.75rem">R</div>
                    <p>No tickets in training corpus yet. Fetch a ticket from Azure DevOps and add it above.</p>
                </div>`;
            return;
        }

        container.innerHTML = trained.map(t => {
            const sevColors = { critical: '#ff4757', high: '#ff6b35', medium: '#ffd32a', low: '#2ed573' };
            const sevCol = sevColors[t.severity] || '#ffd32a';
            const codeLabel = t.codeFiles && t.codeFiles > 0
                ? `${t.codeFiles} code file(s) · PR #${t.prId}`
                : t.hasPR
                    ? `PR #${t.prId} · ${t.changedFiles || 0} files changed`
                    : `Manual resolution`;

            return `
                <div class="trained-item">
                    <div class="trained-item-main">
                        <div class="trained-item-header">
                            <span class="trained-item-id">${this._escapeHtml(t.id)}</span>
                            <span class="severity-badge" style="background:${sevCol}20;color:${sevCol};border-color:${sevCol}40;font-size:0.7rem;padding:0.15rem 0.5rem">${this._escapeHtml(t.severity)}</span>
                            ${t.system ? `<span class="trained-item-system">${this._escapeHtml(t.system)}</span>` : ''}
                            <span class="ref-badge ref-badge--ado" style="font-size:0.68rem">ADO-#${this._escapeHtml(t.adoId)}</span>
                        </div>
                        <div class="trained-item-title">${this._escapeHtml(t.title)}</div>
                        <div class="trained-item-patch">${this._escapeHtml(codeLabel)}</div>
                    </div>
                    <button class="trained-item-delete" onclick="UI._removeTrainingTicket('${this._escapeJsString(String(t.adoId || t.id))}')" title="Remove">x</button>
                </div>`;
        }).join('');
    }
};

// ─────────────────────────────────────────
//  8. SETTINGS MODAL CONTROLLER
// ─────────────────────────────────────────
const SettingsModal = {
    _defaults: {
        title: 'Settings',
        subtitle: 'Set up organization integrations and tune runtime options.'
    },

    _applyMode(mode = 'full') {
        const modal = document.getElementById('settings-modal');
        const titleEl = document.getElementById('settings-title');
        const subtitleEl = document.getElementById('settings-subtitle');
        if (!modal || !titleEl || !subtitleEl) return;

        const onboarding = mode === 'onboarding';
        modal.classList.toggle('settings-modal--onboarding', onboarding);

        if (onboarding) {
            titleEl.textContent = 'Integrate Organization';
            subtitleEl.textContent = 'Complete this initial step to unlock intake, recommendations, and training.';
        } else {
            titleEl.textContent = this._defaults.title;
            subtitleEl.textContent = this._defaults.subtitle;
        }
    },

    open(mode = 'full') {
        const modal = document.getElementById('settings-modal');
        this._applyMode(mode);
        modal.classList.add('open');
        // Populate current settings
        const s = OllamaService.getSettings();
        const reco = RecommendationSettings.get();
        UI._syncModelSelectors(s.model);
        document.getElementById('ollama-toggle').checked = s.enabled;
        document.getElementById('ollama-temp').value = s.temperature;
        document.getElementById('ollama-temp-val').textContent = s.temperature;
        const recoDebugToggle = document.getElementById('reco-debug-toggle');
        if (recoDebugToggle) recoDebugToggle.checked = !!reco.debugMode;
        const backendToggle = document.getElementById('backend-toggle');
        if (backendToggle) backendToggle.checked = !!reco.backendEnabled;
        const backendUrlInput = document.getElementById('backend-url');
        if (backendUrlInput) backendUrlInput.value = reco.backendUrl || DEFAULT_BACKEND_URL;
        const backendTopKInput = document.getElementById('backend-topk');
        if (backendTopKInput) backendTopKInput.value = String(Math.max(1, Math.min(10, Number(reco.backendTopK || 5))));
        const backendStatus = document.getElementById('backend-status');
        if (backendStatus) backendStatus.textContent = '';
        if (typeof UI._refreshIntegrationSettings === 'function') UI._refreshIntegrationSettings();
        const integrationName = document.getElementById('integration-name');
        if (integrationName) setTimeout(() => integrationName.focus(), 0);
    },

    close() {
        document.getElementById('settings-modal').classList.remove('open');
        this._applyMode('full');
    },

    save() {
        const enabled = document.getElementById('ollama-toggle').checked;
        const model = document.getElementById('ollama-model').value.trim() || 'phi4';
        const temperature = parseFloat(document.getElementById('ollama-temp').value);
        const debugMode = !!document.getElementById('reco-debug-toggle')?.checked;
        const backendEnabled = !!document.getElementById('backend-toggle')?.checked;
        const backendUrl = String(document.getElementById('backend-url')?.value || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL;
        const backendTopK = Math.max(1, Math.min(10, Number(document.getElementById('backend-topk')?.value || 5)));
        const prevReco = RecommendationSettings.get();
        const backendStatus = backendEnabled
            ? ((prevReco.backendUrl !== backendUrl || !prevReco.backendEnabled) ? 'unknown' : (prevReco.backendStatus || 'unknown'))
            : 'unknown';
        OllamaService.saveSettings({ enabled, model, temperature });
        UI._syncModelSelectors(model);
        const updatedReco = RecommendationSettings.save({ debugMode, backendEnabled, backendUrl, backendTopK, backendStatus });
        UI.recommendationDebug = debugMode;
        UI._updateEngineIndicator(enabled, OllamaService.getSettings().lastStatus, updatedReco.backendEnabled, updatedReco.backendStatus);
        this.close();
        UI._showToast(
            backendEnabled
                ? `Backend engine enabled (${backendUrl}).`
                : (enabled
                    ? `Ollama enabled with model "${model}" — click Test Connection to verify.`
                    : 'Switched back to local Hybrid engine.'),
            'info'
        );
    },

    async testConnection() {
        const btn = document.getElementById('test-conn-btn');
        const status = document.getElementById('conn-status');
        btn.disabled = true;
        btn.textContent = 'Testing...';
        status.textContent = '';

        const result = await OllamaService.checkConnection();

        btn.disabled = false;
        btn.textContent = 'Test Connection';

        if (result.connected) {
            const models = result.models || [];
            status.style.color = 'var(--success)';
            status.textContent = `Connected. Found ${models.length} model(s): ${models.slice(0, 5).join(', ')}`;
            const curModel = document.getElementById('ollama-model').value || OllamaService.getSettings().model;
            const installed = models.some(m => m.startsWith(String(curModel).split(':')[0]));
            const nextModel = installed ? curModel : (models[0] || curModel || 'phi4');
            UI._syncModelSelectors(nextModel, models);
            if (!installed && models.length > 0) {
                status.style.color = 'var(--warning)';
                status.textContent += ` | Model "${curModel}" not found — switched to "${nextModel}"`;
            }
        } else {
            status.style.color = 'var(--danger)';
            status.textContent = `${result.error}. Run: ollama serve then ollama pull phi4`;
        }

        const reco = RecommendationSettings.get();
        UI._updateEngineIndicator(
            document.getElementById('ollama-toggle').checked,
            OllamaService.getSettings().lastStatus,
            reco.backendEnabled,
            reco.backendStatus
        );
    },

    async testBackendConnection() {
        const btn = document.getElementById('test-backend-btn');
        const status = document.getElementById('backend-status');
        const url = String(document.getElementById('backend-url')?.value || '').trim();

        btn.disabled = true;
        btn.textContent = 'Testing...';
        status.textContent = '';

        const result = await BackendRecommendationService.healthCheck(url);

        btn.disabled = false;
        btn.textContent = 'Test Backend';

        if (result.ok) {
            const tickets = Number(result.data?.tickets_loaded || 0);
            const embedding = result.data?.ollama_reachable ? 'Ollama reachable' : 'Ollama not reachable';
            const localCorpus = getRecommendationCorpus();
            const localCount = localCorpus.length;
            const localWithPatch = localCorpus.filter(t => t && t.resolvedPatch).length;
            status.style.color = 'var(--success)';
            status.textContent = `Connected. Backend DB corpus: ${tickets}. ${embedding}. Local browser corpus: ${localCount} (${localWithPatch} mapped).`;
            const saved = RecommendationSettings.save({ backendStatus: 'connected', backendUrl: url || DEFAULT_BACKEND_URL });
            UI._updateEngineIndicator(
                document.getElementById('ollama-toggle').checked,
                OllamaService.getSettings().lastStatus,
                saved.backendEnabled,
                saved.backendStatus
            );
        } else {
            status.style.color = 'var(--danger)';
            status.textContent = `${result.error}`;
            const saved = RecommendationSettings.save({ backendStatus: 'disconnected', backendUrl: url || DEFAULT_BACKEND_URL });
            UI._updateEngineIndicator(
                document.getElementById('ollama-toggle').checked,
                OllamaService.getSettings().lastStatus,
                saved.backendEnabled,
                saved.backendStatus
            );
        }
    }
};

// Patch UI with Ollama-related methods
Object.assign(UI, {
    _updateEngineIndicator(enabled, status, backendEnabled = false, backendStatus = 'unknown') {
        const ind = document.getElementById('engine-indicator');
        if (!ind) return;
        if (backendEnabled) {
            if (backendStatus === 'connected' || backendStatus === 'unknown') {
                ind.innerHTML = 'Backend RAG';
                ind.className = 'engine-indicator engine-indicator--backend';
            } else {
                ind.innerHTML = 'Backend Offline';
                ind.className = 'engine-indicator engine-indicator--warn';
            }
            this._renderQuickRuntimeDetails();
            return;
        }
        if (enabled && status === 'connected') {
            ind.innerHTML = 'Ollama';
            ind.className = 'engine-indicator engine-indicator--llm';
        } else if (enabled) {
            ind.innerHTML = 'Ollama Offline';
            ind.className = 'engine-indicator engine-indicator--warn';
        } else {
            ind.innerHTML = 'Hybrid';
            ind.className = 'engine-indicator engine-indicator--tfidf';
        }
        this._renderQuickRuntimeDetails();
    }
});

// ─────────────────────────────────────────
//  9. BOOT
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    UI.init();

    // ── Hydrate PATCH_LIBRARY from TrainingStore on every page load ──
    // Without this, trained custom patches are lost on refresh since PATCH_LIBRARY is in-memory only.
    (function hydratePatchLibrary() {
        const trained = TrainingStore.getAll();
        trained.forEach(t => {
            // Reconstruct the custom patch object from the stored training ticket
            const patchId = t.resolvedPatch;
            if (!patchId || PATCH_LIBRARY.some(p => p.id === patchId)) return; // already present

            const pr = t.prId ? { prId: t.prId } : null;
            const codeSnippets = Array.isArray(t.codeSnippets) ? t.codeSnippets : [];
            const patchSteps = codeSnippets.length
                ? codeSnippets.map(cs => `// ${cs.changeType}: ${cs.file}\n${cs.snippet.substring(0, 600)}`)
                : [t.resolutionDescription || 'See training ticket for details'];

            PATCH_LIBRARY.push({
                id: patchId,
                name: t.hasPR ? `PR Fix: ${t.title.substring(0, 60)}` : `Fix: ${t.title.substring(0, 60)}`,
                type: 'trained',
                description: t.resolutionDescription?.substring(0, 500) || t.description?.substring(0, 200) || '',
                riskLevel: 'medium',
                estimatedTime: 'Varies',
                restartRequired: false,
                tags: Array.isArray(t.tags) ? t.tags : [],
                steps: patchSteps,
                codeSnippets,
                referenceAdoId: t.adoId,
                prId: t.prId || null,
                repoName: null
            });
        });
    })();

    // Make globally accessible for inline handlers
    window.UI = UI;
    window.SettingsModal = SettingsModal;
    window.OllamaService = OllamaService;
    window.FeedbackStore = FeedbackStore;
    window.TrainingStore = TrainingStore;

    // Settings modal events
    document.getElementById('modal-close-btn').addEventListener('click', () => SettingsModal.close());
    document.getElementById('modal-save-btn').addEventListener('click', () => SettingsModal.save());
    document.getElementById('test-conn-btn').addEventListener('click', () => SettingsModal.testConnection());
    document.getElementById('test-backend-btn')?.addEventListener('click', () => SettingsModal.testBackendConnection());
    document.getElementById('ollama-model')?.addEventListener('change', (e) => {
        UI._syncModelSelectors(String(e.target.value || 'phi4'));
    });
    document.getElementById('ollama-temp').addEventListener('input', (e) => {
        document.getElementById('ollama-temp-val').textContent = e.target.value;
    });
    // Close modal on backdrop click
    document.getElementById('settings-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) SettingsModal.close();
    });

    // Keyboard shortcut: Ctrl+Enter to submit
    document.addEventListener('keydown', (e) => {
        const isSettingsOpen = document.getElementById('settings-modal')?.classList.contains('open');
        const isLandingActive = document.body.classList.contains('landing-active');
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (isSettingsOpen || isLandingActive) return;
            const form = document.getElementById('ticket-form');
            if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
        if (e.key === 'Escape') {
            SettingsModal.close();
            UI._closeQuickSettingsMenu();
        }
    });
});
