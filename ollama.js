// ============================================================
// ollama.js — Ollama Local LLM Integration
// Calls localhost:11434 — Zero data leaves the machine
// Falls back to TF-IDF engine if Ollama is not running
// ============================================================

'use strict';

const OllamaService = {

    BASE_URL: 'http://localhost:11434',
    SETTINGS_KEY: 'az_ollama_settings',
    TIMEOUT_MS: 30000, // 30s timeout for LLM responses
    EMBEDDING_TIMEOUT_MS: 12000,
    _embeddingCache: new Map(),
    _embeddingCacheLimit: 500,

    // ── Default settings ──
    _defaults: {
        enabled: false,
        model: 'phi4',
        embeddingModel: 'nomic-embed-text',
        temperature: 0.2,
        lastStatus: 'unknown' // 'connected' | 'disconnected' | 'unknown'
    },

    // ── Settings persistence ──
    getSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(this.SETTINGS_KEY) || '{}');
            return { ...this._defaults, ...saved };
        } catch { return { ...this._defaults }; }
    },

    saveSettings(patch) {
        const current = this.getSettings();
        const updated = { ...current, ...patch };
        try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(updated)); }
        catch { return current; }
        return updated;
    },

    isEnabled() {
        return this.getSettings().enabled;
    },

    _textForEmbedding(ticket) {
        return [
            ticket.title || '',
            ticket.severity || '',
            ticket.system || '',
            Array.isArray(ticket.tags) ? ticket.tags.join(' ') : (ticket.tags || ''),
            ticket.description || ''
        ].join(' ').replace(/\s+/g, ' ').trim();
    },

    _resolutionText(ticket) {
        return String(ticket.resolutionDescription || ticket.resolution || ticket.description || '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    _promptSafe(text, maxLen = 260) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLen);
    },

    _vectorCosine(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < a.length; i++) {
            const x = Number(a[i]) || 0;
            const y = Number(b[i]) || 0;
            dot += x * y;
            magA += x * x;
            magB += y * y;
        }
        const denom = Math.sqrt(magA) * Math.sqrt(magB);
        return denom === 0 ? 0 : dot / denom;
    },

    _cacheEmbedding(key, vec) {
        if (!key || !Array.isArray(vec)) return;
        this._embeddingCache.set(key, vec);
        if (this._embeddingCache.size > this._embeddingCacheLimit) {
            const first = this._embeddingCache.keys().next();
            if (!first.done) this._embeddingCache.delete(first.value);
        }
    },

    async _embedText(text, model) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return null;
        const cacheKey = `${model}|${normalized.slice(0, 700)}`;
        if (this._embeddingCache.has(cacheKey)) return this._embeddingCache.get(cacheKey);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.EMBEDDING_TIMEOUT_MS);
        try {
            let res = await fetch(`${this.BASE_URL}/api/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ model, input: normalized, truncate: true })
            });

            if (res.ok) {
                const data = await res.json();
                const vec = Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0])
                    ? data.embeddings[0]
                    : null;
                if (vec?.length) {
                    this._cacheEmbedding(cacheKey, vec);
                    return vec;
                }
            }

            // Backward compatibility for older Ollama versions.
            res = await fetch(`${this.BASE_URL}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ model, prompt: normalized })
            });
            if (res.ok) {
                const data = await res.json();
                const vec = Array.isArray(data.embedding) ? data.embedding : null;
                if (vec?.length) {
                    this._cacheEmbedding(cacheKey, vec);
                    return vec;
                }
            }
            return null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    },

    _lexicalCandidateIncidents(ticket) {
        const fullText = this._textForEmbedding(ticket);
        if (typeof PatchRecommender !== 'undefined' && PatchRecommender.findSimilarResolvedTickets) {
            return PatchRecommender
                .findSimilarResolvedTickets(fullText, ticket.severity, ticket.system, 18)
                .map(m => ({ ticket: m.ticket, similarity: m.similarity || 0 }));
        }

        if (typeof getRecommendationCorpus !== 'function') return [];
        return getRecommendationCorpus()
            .filter(t => t?.resolvedPatch)
            .slice(0, 18)
            .map((t, idx) => ({ ticket: t, similarity: Math.max(0, 0.2 - idx * 0.01) }));
    },

    async _findSimilarResolvedByEmbedding(ticket, limit = 3) {
        const lexical = this._lexicalCandidateIncidents(ticket)
            .filter(m => m.ticket?.resolvedPatch)
            .filter(m => this._resolutionText(m.ticket).length > 0);
        if (!lexical.length) return [];

        const settings = this.getSettings();
        const embeddingModel = settings.embeddingModel || 'nomic-embed-text';
        const queryVec = await this._embedText(this._textForEmbedding(ticket), embeddingModel);
        if (!queryVec) return lexical.slice(0, limit);

        const scored = [];
        for (const candidate of lexical.slice(0, 18)) {
            const t = candidate.ticket;
            const docText = [
                t.title || '',
                t.severity || '',
                t.system || '',
                Array.isArray(t.tags) ? t.tags.join(' ') : (t.tags || ''),
                this._resolutionText(t),
                t.resolvedPatch || ''
            ].join(' ');
            const docVec = await this._embedText(docText, embeddingModel);
            if (!docVec) continue;
            const similarity = this._vectorCosine(queryVec, docVec);
            scored.push({ ticket: t, similarity });
        }

        if (!scored.length) return lexical.slice(0, limit);
        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, limit);
    },

    // ── Connection check ──
    async checkConnection() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(`${this.BASE_URL}/api/tags`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error('Non-200 response');
            const data = await res.json();
            const models = (data.models || []).map(m => m.name);
            this.saveSettings({ lastStatus: 'connected' });
            return { connected: true, models };
        } catch (err) {
            this.saveSettings({ lastStatus: 'disconnected' });
            if (err.name === 'AbortError') {
                return { connected: false, error: 'Connection timed out — is Ollama running?' };
            }
            return { connected: false, error: 'Ollama not reachable at localhost:11434' };
        }
    },

    // ── Build the recommendation prompt ──
    _buildPrompt(ticket, patches, topMatches = []) {
        const patchSummaries = patches.map(p =>
            `- ID: ${p.id} | Name: "${p.name}" | Type: ${p.type} | Risk: ${p.riskLevel} | Tags: ${p.tags.join(', ')}`
        ).join('\n');

        const patchNameById = Object.fromEntries((patches || []).map(p => [String(p.id), p.name || p.id]));
        const similarIncidentsSection = topMatches.length
            ? topMatches.slice(0, 3).map(m => {
                const t = m.ticket || {};
                const patchId = String(t.resolvedPatch || 'Unknown');
                const patchLabel = patchNameById[patchId] ? `${patchId} (${patchNameById[patchId]})` : patchId;
                return `- Ticket: "${this._promptSafe(t.title || 'Untitled incident', 170)}"
  Resolution: ${this._promptSafe(this._resolutionText(t) || 'No resolution text available', 260)}
  Patch applied: ${this._promptSafe(patchLabel, 120)}`;
            }).join('\n')
            : '- None available.';

        return `You are a senior Azure database reliability engineer specializing in diagnosing and resolving database incidents.

INCOMING SUPPORT TICKET:
------------------------
Title: ${ticket.title}
Severity: ${ticket.severity}
System: ${ticket.system || 'Not specified'}
Tags: ${ticket.tags || 'None'}
Description:
${ticket.description}

SIMILAR PAST INCIDENTS (already resolved):
-------------------------------------------
${similarIncidentsSection}

AVAILABLE DATABASE PATCHES:
----------------------------
${patchSummaries}

TASK:
Analyze the ticket and determine which patches from the list above are most applicable.
Consider: error patterns, symptoms, database system type, severity, common root causes, and the evidence from similar past incidents.

Return a JSON array of up to 5 patch recommendations, sorted by confidence (highest first).
Each object must have exactly these fields:
- "patchId": string (the patch ID, e.g. "P001")
- "confidence": integer from 1 to 98
- "reasoning": string (1-2 sentences explaining why this patch applies)

Rules:
- Only recommend patches from the provided list (use exact IDs)
- Be precise — only include patches that genuinely apply to the described issue
- Use similar past incidents as evidence when deciding
- Confidence should reflect how well the patch matches the described symptoms
- Return ONLY the JSON array, no other text, no markdown fences

Example output:
[{"patchId":"P001","confidence":94,"reasoning":"The 1205 deadlock error and mutual blocking described directly indicate SQL Server deadlock contention."},{"patchId":"P005","confidence":61,"reasoning":"Timeout symptoms may also relate to slow queries if deadlock resolution alone is insufficient."}]`;
    },

    // ── Core LLM recommendation call ──
    async recommend(ticket, patches) {
        const settings = this.getSettings();
        const similarIncidents = await this._findSimilarResolvedByEmbedding(ticket, 3);
        const prompt = this._buildPrompt(ticket, patches, similarIncidents);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

        try {
            const res = await fetch(`${this.BASE_URL}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: settings.model,
                    prompt,
                    stream: false,
                    options: {
                        temperature: settings.temperature,
                        top_p: 0.9,
                        num_predict: 800
                    }
                })
            });
            clearTimeout(timer);

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama error ${res.status}: ${errText}`);
            }

            const data = await res.json();
            const rawText = (data.response || '').trim();

            // Parse the JSON from the response
            const parsed = this._parseRecommendations(rawText, patches, similarIncidents);
            return { success: true, recommendations: parsed, rawResponse: rawText, similarIncidents };

        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                return { success: false, error: `LLM timed out after ${this.TIMEOUT_MS / 1000}s. Try a smaller/faster model.` };
            }
            return { success: false, error: err.message };
        }
    },

    // ── Parse & validate LLM JSON output ──
    _parseRecommendations(rawText, patches, similarIncidents = []) {
        // Strip any accidental markdown code fences
        let cleaned = rawText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        // Extract JSON array if there's surrounding text
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) cleaned = match[0];

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            // Try to rescue partial JSON
            try {
                const fixedJson = cleaned.replace(/,\s*\]$/, ']').replace(/,$/, '');
                parsed = JSON.parse(fixedJson);
            } catch {
                throw new Error('LLM returned unparseable response — check model or retry');
            }
        }

        if (!Array.isArray(parsed)) throw new Error('LLM response was not a JSON array');

        // Validate and enrich each recommendation
        const patchMap = Object.fromEntries(patches.map(p => [p.id, p]));
        const results = [];

        for (const item of parsed) {
            if (!item.patchId || !patchMap[item.patchId]) continue; // skip invalid IDs
            const confidence = Math.max(1, Math.min(98, parseInt(item.confidence) || 50));
            results.push({
                patch: patchMap[item.patchId],
                confidence,
                reasoning: item.reasoning || 'Recommended by LLM analysis.',
                matchCount: similarIncidents.length,
                matchedTickets: similarIncidents.slice(0, 3),
                feedbackStats: FeedbackStore.getStats(item.patchId),
                source: 'ollama'
            });
        }

        // Apply feedback boosts to re-order (same as TF-IDF engine)
        results.forEach(r => {
            const boost = FeedbackStore.getBoost(r.patch.id);
            r.adjustedConfidence = Math.min(98, Math.round(r.confidence * (boost > 1 ? 1 + (boost - 1) * 0.3 : boost)));
        });
        results.sort((a, b) => b.adjustedConfidence - a.adjustedConfidence);

        return results.slice(0, 5);
    },

    // ── Quick model availability check ──
    async modelExists(modelName) {
        const { connected, models } = await this.checkConnection();
        if (!connected) return false;
        return (models || []).some(m => m.startsWith(modelName.split(':')[0]));
    }
};
