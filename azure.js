// ============================================================
// azure.js — Azure DevOps Integration Service
// Per-org isolated localStorage namespacing
// Calls only your org's dev.azure.com endpoint (no 3rd parties)
// ============================================================

'use strict';

const AzureDevOpsService = {

    // ── Storage keys ──
    ORGS_KEY: 'azpatch_orgs',
    ACTIVE_ORG_KEY: 'azpatch_active_org',
    // Safety default: never write back to Azure DevOps work items from this app.
    READ_ONLY_TICKETS: true,

    _safeSetLocal(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch {
            return false;
        }
    },

    _safeRemoveLocal(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch {
            return false;
        }
    },

    // ── Org storage helpers ──
    _orgKey(orgId, suffix) {
        return `azpatch_org_${orgId}_${suffix}`;
    },

    getAllOrgs() {
        try { return JSON.parse(localStorage.getItem(this.ORGS_KEY) || '[]'); }
        catch { return []; }
    },

    saveOrg(org) {
        // org: { id, name, orgUrl, project, pat, createdAt }
        const orgs = this.getAllOrgs();
        const idx = orgs.findIndex(o => o.id === org.id);
        if (idx >= 0) orgs[idx] = org;
        else orgs.push(org);
        this._safeSetLocal(this.ORGS_KEY, JSON.stringify(orgs));
    },

    deleteOrg(orgId) {
        const orgs = this.getAllOrgs().filter(o => o.id !== orgId);
        this._safeSetLocal(this.ORGS_KEY, JSON.stringify(orgs));
        // Clear all org-namespaced data
        const keysToDelete = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(`azpatch_org_${orgId}_`)) keysToDelete.push(k);
            }
        } catch {
            // ignore storage iteration errors
        }
        keysToDelete.forEach(k => this._safeRemoveLocal(k));
        if (this.getActiveOrgId() === orgId) this._safeRemoveLocal(this.ACTIVE_ORG_KEY);
    },

    getActiveOrgId() {
        try { return localStorage.getItem(this.ACTIVE_ORG_KEY) || null; }
        catch { return null; }
    },

    getActiveOrg() {
        const id = this.getActiveOrgId();
        if (!id) return null;
        return this.getAllOrgs().find(o => o.id === id) || null;
    },

    setActiveOrg(orgId) {
        this._safeSetLocal(this.ACTIVE_ORG_KEY, orgId);
        // Notify FeedbackStore to switch namespace
        if (typeof FeedbackStore !== 'undefined') {
            FeedbackStore.setOrgNamespace(orgId);
        }
    },

    generateOrgId(orgUrl, project) {
        // Stable slug from URL + project, e.g. "mycompany_myproject"
        const orgPart = orgUrl.replace(/https?:\/\//, '').replace(/dev\.azure\.com\//, '').replace(/\//g, '').toLowerCase();
        const projPart = project.toLowerCase().replace(/[^a-z0-9]/g, '_');
        return `${orgPart}_${projPart}`.substring(0, 40);
    },

    // ── Per-org data access ──
    getOrgData(orgId, key, fallback = null) {
        try {
            const raw = localStorage.getItem(this._orgKey(orgId, key));
            return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
    },

    setOrgData(orgId, key, value) {
        this._safeSetLocal(this._orgKey(orgId, key), JSON.stringify(value));
    },

    // ── API Auth header ──
    _authHeader(pat) {
        return 'Basic ' + btoa(':' + pat);
    },

    _normalizeEmail(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/^mailto:/, '');
    },

    _extractEmails(text) {
        const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
        return Array.from(new Set(matches.map(m => this._normalizeEmail(m)).filter(Boolean)));
    },

    _identityEmails(identity) {
        if (!identity) return [];
        if (typeof identity === 'string') return this._extractEmails(identity);

        return Array.from(new Set([
            ...this._extractEmails(identity.uniqueName),
            ...this._extractEmails(identity.mailAddress),
            ...this._extractEmails(identity.displayName)
        ]));
    },

    isTicketWriteEnabled() {
        return this.READ_ONLY_TICKETS !== true;
    },

    // ── Test connection ──
    async testConnection(orgUrl, project, pat) {
        const base = orgUrl.replace(/\/$/, '');
        // Use $top=1 to avoid the 20K item size-limit error on large projects
        const url = `${base}/${encodeURIComponent(project)}/_apis/wit/wiql?$top=1&api-version=7.0`;
        const body = {
            query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' ORDER BY [System.ChangedDate] DESC`
        };

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': this._authHeader(pat),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timer);

            if (res.status === 401) return { ok: false, error: 'Unauthorized — check your PAT (needs Read scope on Work Items)' };
            if (res.status === 404) return { ok: false, error: `Project "${project}" not found in ${orgUrl}` };
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };

            const data = await res.json();
            return { ok: true, totalCount: data.workItems?.length || 0 };
        } catch (err) {
            if (err.name === 'AbortError') return { ok: false, error: 'Connection timed out — check your org URL' };
            return { ok: false, error: err.message };
        }
    },

    // ── Fetch work items via WIQL ──
    async fetchWorkItems(org, options = {}) {
        const { orgUrl, project, pat } = org;
        const base = orgUrl.replace(/\/$/, '');
        const requestedLimit = Math.max(1, parseInt(options.limit || 50, 10));
        const hasCreatorFilter = Array.isArray(options.creatorEmails) && options.creatorEmails.length > 0;

        const stateFilter = options.states?.length
            ? `AND [System.State] IN (${options.states.map(s => `'${s}'`).join(',')})`
            : `AND [System.State] NOT IN ('Closed', 'Resolved', 'Done')`;

        const typeFilter = options.types?.length
            ? `AND [System.WorkItemType] IN (${options.types.map(t => `'${t}'`).join(',')})`
            : '';

        const orderBy = hasCreatorFilter
            ? '[System.ChangedDate] DESC'
            : '[Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC';

        const wiql = {
            query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [Microsoft.VSTS.Common.Priority]
              FROM WorkItems
              WHERE [System.TeamProject] = '${project}'
              ${stateFilter}
              ${typeFilter}
              ORDER BY ${orderBy}`
        };

        try {
            // When filtering by creators we scan a wider set, then post-filter by createdBy email.
            const wiqlTop = hasCreatorFilter
                ? Math.min(20000, Math.max(requestedLimit * 20, 2000))
                : requestedLimit;

            const wiqlRes = await fetch(`${base}/${encodeURIComponent(project)}/_apis/wit/wiql?$top=${wiqlTop}&api-version=7.0`, {
                method: 'POST',
                headers: { 'Authorization': this._authHeader(pat), 'Content-Type': 'application/json' },
                body: JSON.stringify(wiql)
            });

            if (!wiqlRes.ok) throw new Error(`WIQL failed: ${wiqlRes.status}`);
            const wiqlData = await wiqlRes.json();

            if (!wiqlData.workItems?.length) return { ok: true, items: [] };

            const fields = [
                'System.Id',
                'System.Title',
                'System.Description',
                'System.State',
                'System.WorkItemType',
                'System.AssignedTo',
                'System.CreatedBy',
                'System.CreatedDate',
                'System.ChangedDate',
                'System.Tags',
                'Microsoft.VSTS.Common.Priority',
                'Microsoft.VSTS.Common.Severity',
                'System.AreaPath'
            ].join(',');

            // Batch fetch details (ADO allows up to 200 IDs/request)
            const ids = wiqlData.workItems.slice(0, wiqlTop).map(w => w.id);
            const detailItems = [];
            for (let i = 0; i < ids.length; i += 200) {
                const batchIds = ids.slice(i, i + 200).join(',');
                const detailRes = await fetch(
                    `${base}/_apis/wit/workitems?ids=${batchIds}&fields=${fields}&api-version=7.0`,
                    { headers: { 'Authorization': this._authHeader(pat) } }
                );
                if (!detailRes.ok) throw new Error(`Detail fetch failed: ${detailRes.status}`);
                const detailData = await detailRes.json();
                detailItems.push(...(detailData.value || []));
            }

            let items = detailItems.map(wi => this._normalizeWorkItem(wi, org));
            let creatorMatchedCount = items.length;

            if (hasCreatorFilter) {
                const allowed = new Set(
                    options.creatorEmails
                        .map(e => this._normalizeEmail(e))
                        .filter(Boolean)
                );
                const allowedAliases = Array.from(allowed)
                    .map(email => email.split('@')[0] || '')
                    .map(alias => alias.toLowerCase().replace(/[^a-z0-9]/g, ''))
                    .filter(Boolean);

                items = items.filter(item => {
                    const candidates = new Set([
                        ...this._extractEmails(item.createdByEmail || ''),
                        ...this._extractEmails(item.createdBy || ''),
                        ...(Array.isArray(item.createdByEmails) ? item.createdByEmails.map(v => this._normalizeEmail(v)) : [])
                    ]);
                    if (Array.from(candidates).some(email => allowed.has(email))) return true;

                    const displayToken = String(item.createdBy || '')
                        .toLowerCase()
                        .replace(/[^a-z0-9]/g, '');
                    if (!displayToken) return false;
                    return allowedAliases.some(alias => displayToken.includes(alias));
                });

                creatorMatchedCount = items.length;
            }

            items = items
                .sort((a, b) => new Date(b.changedDate || 0) - new Date(a.changedDate || 0))
                .slice(0, requestedLimit);

            // Cache in org-isolated storage
            this.setOrgData(org.id, 'cached_items', items);
            this.setOrgData(org.id, 'last_sync', new Date().toISOString());

            return {
                ok: true,
                items,
                meta: {
                    requestedLimit,
                    wiqlTop,
                    scannedCount: detailItems.length,
                    creatorMatchedCount
                }
            };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    // ── Fetch a single work item by ID (with relations for PR detection) ──
    async getWorkItemById(org, workItemId, options = {}) {
        const { orgUrl, project, pat } = org;
        const base = orgUrl.replace(/\/$/, '');
        const includeComments = options.includeComments !== false;

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);

            // Fetch with $expand=relations to get linked PRs (can't use fields with expand)
            const res = await fetch(
                `${base}/_apis/wit/workitems/${workItemId}?$expand=relations&api-version=7.0`,
                {
                    headers: { 'Authorization': this._authHeader(pat) },
                    signal: controller.signal
                }
            );
            clearTimeout(timer);

            if (res.status === 401) return { ok: false, error: 'Unauthorized — check your PAT' };
            if (res.status === 404) return { ok: false, error: `Work item #${workItemId} not found` };
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };

            const wi = await res.json();
            const item = this._normalizeWorkItem(wi, org);

            // Extract linked PR references from relations
            item.linkedPRs = this._extractPRLinks(wi.relations || [], org);

            let comments = [];
            if (includeComments) {
                // Also include comments for richer context
                try {
                    const commentsRes = await fetch(
                        `${base}/_apis/wit/workitems/${workItemId}/comments?api-version=7.0-preview.3`,
                        { headers: { 'Authorization': this._authHeader(pat) } }
                    );
                    if (commentsRes.ok) {
                        const commentsData = await commentsRes.json();
                        comments = (commentsData.comments || []).map(c => ({
                            text: this._stripHtml(c.text || ''),
                            author: c.createdBy?.displayName || 'Unknown',
                            date: c.createdDate
                        }));
                    }
                } catch (_) { /* comments are optional */ }
            }

            item.comments = comments;
            return { ok: true, item };
        } catch (err) {
            if (err.name === 'AbortError') return { ok: false, error: 'Request timed out' };
            return { ok: false, error: err.message };
        }
    },

    // ── Extract PR links from work item relations ──
    _extractPRLinks(relations, org) {
        if (!relations || !relations.length) return [];
        return relations
            .filter(r => {
                // ArtifactLink pointing to a Pull Request
                const isPR = r.attributes?.name === 'Pull Request'
                    || (r.url && r.url.includes('vstfs:///Git/PullRequestId'));
                return isPR;
            })
            .map(r => {
                // Parse PR artifact URI: vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}
                const url = r.url || '';
                const match = url.match(/PullRequestId\/([^%]+)%2F([^%]+)%2F(\d+)/i)
                    || url.match(/PullRequestId\/([^\/]+)\/([^\/]+)\/(\d+)/i);
                if (match) {
                    return { projectId: match[1], repoId: match[2], prId: parseInt(match[3]) };
                }
                // Fallback: try extracting just the PR ID from the URL
                const idMatch = url.match(/\/(\d+)$/);
                if (idMatch) return { prId: parseInt(idMatch[1]) };
                return null;
            })
            .filter(Boolean);
    },

    // ── Fetch PR details ──
    async getPullRequestDetails(org, prId) {
        const { orgUrl, project, pat } = org;
        const base = orgUrl.replace(/\/$/, '');

        try {
            // Use the project-scoped PR endpoint
            const res = await fetch(
                `${base}/${encodeURIComponent(project)}/_apis/git/pullrequests/${prId}?api-version=7.0`,
                { headers: { 'Authorization': this._authHeader(pat) } }
            );

            if (!res.ok) {
                // Try org-wide endpoint as fallback
                const res2 = await fetch(
                    `${base}/_apis/git/pullrequests/${prId}?api-version=7.0`,
                    { headers: { 'Authorization': this._authHeader(pat) } }
                );
                if (!res2.ok) return { ok: false, error: `PR #${prId} not found` };
                const pr2 = await res2.json();
                return { ok: true, pr: this._normalizePR(pr2) };
            }

            const pr = await res.json();
            return { ok: true, pr: this._normalizePR(pr) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    // ── Fetch PR file changes (iterations-based diff) ──
    async getPullRequestChanges(org, repoId, prId) {
        const { orgUrl, pat } = org;
        const base = orgUrl.replace(/\/$/, '');

        try {
            // Get iterations to find the latest
            const iterRes = await fetch(
                `${base}/_apis/git/repositories/${repoId}/pullrequests/${prId}/iterations?api-version=7.0`,
                { headers: { 'Authorization': this._authHeader(pat) } }
            );

            if (!iterRes.ok) return { ok: false, error: 'Could not fetch PR iterations' };
            const iterData = await iterRes.json();
            const iterations = iterData.value || [];
            if (!iterations.length) return { ok: true, changes: [] };

            // Get changes from the last iteration (final state)
            const lastIter = iterations[iterations.length - 1];
            const changesRes = await fetch(
                `${base}/_apis/git/repositories/${repoId}/pullrequests/${prId}/iterations/${lastIter.id}/changes?api-version=7.0`,
                { headers: { 'Authorization': this._authHeader(pat) } }
            );

            if (!changesRes.ok) return { ok: false, error: 'Could not fetch PR changes' };
            const changesData = await changesRes.json();

            const changes = (changesData.changeEntries || []).map(c => ({
                path: c.item?.path || 'Unknown',
                changeType: this._changeTypeName(c.changeType),
                objectId: c.item?.objectId || null,
                isFolder: c.item?.isFolder || false
            })).filter(c => !c.isFolder);

            // Return the commitId of the last iteration so callers can fetch file content
            const mergeCommitId = lastIter.sourceRefCommit?.commitId || lastIter.commonRefCommit?.commitId || null;

            return { ok: true, changes, iterationCount: iterations.length, mergeCommitId, repoId };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    // ── Fetch raw file content at a specific commit (for code extraction) ──
    async getFileContentAtCommit(org, repoId, filePath, commitId) {
        const { orgUrl, pat } = org;
        const base = orgUrl.replace(/\/$/, '');
        try {
            // ADO Items API returns raw content when Accept header is text/plain
            const url = `${base}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.versionType=commit&versionDescriptor.version=${encodeURIComponent(commitId)}&api-version=7.0`;
            const res = await fetch(url, {
                headers: {
                    'Authorization': this._authHeader(pat),
                    'Accept': 'text/plain'
                }
            });
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
            const content = await res.text();
            // Limit to 4KB to keep localStorage small
            return { ok: true, content: content.substring(0, 4096) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    _normalizePR(pr) {
        return {
            prId: pr.pullRequestId,
            title: pr.title || '',
            description: pr.description || '',
            status: pr.status || 'unknown', // active, completed, abandoned
            createdBy: pr.createdBy?.displayName || 'Unknown',
            createdDate: pr.creationDate,
            closedDate: pr.closedDate,
            sourceBranch: (pr.sourceRefName || '').replace('refs/heads/', ''),
            targetBranch: (pr.targetRefName || '').replace('refs/heads/', ''),
            repoId: pr.repository?.id || '',
            repoName: pr.repository?.name || '',
            mergeStatus: pr.mergeStatus || '',
            reviewers: (pr.reviewers || []).map(r => ({
                name: r.displayName,
                vote: r.vote // 10=approved, 5=approved with suggestions, -5=wait, -10=rejected
            })),
            url: pr._links?.web?.href || ''
        };
    },

    _changeTypeName(type) {
        const map = {
            1: 'Add', 2: 'Edit', 4: 'Encoding', 8: 'Rename', 16: 'Delete',
            32: 'Undelete', 64: 'SourceRename', 128: 'TargetRename', 256: 'Property'
        };
        // type can be a bitmask
        const names = [];
        for (const [bit, name] of Object.entries(map)) {
            if (type & parseInt(bit)) names.push(name);
        }
        return names.join(', ') || 'Edit';
    },

    // ── Normalize ADO work item to app format ──
    _normalizeWorkItem(wi, org) {
        const f = wi.fields || {};
        const createdByIdentity = f['System.CreatedBy'];
        const createdByEmails = this._identityEmails(createdByIdentity);
        // Severity mapping ADO → app format
        const sevMap = {
            '1 - Critical': 'critical', 'Critical': 'critical',
            '2 - High': 'high', 'High': 'high',
            '3 - Medium': 'medium', 'Medium': 'medium',
            '4 - Low': 'low', 'Low': 'low'
        };
        // Priority → severity fallback
        const priMap = { 1: 'critical', 2: 'high', 3: 'medium', 4: 'low' };

        const adoSeverity = f['Microsoft.VSTS.Common.Severity'] || '';
        const adoPriority = f['Microsoft.VSTS.Common.Priority'] || 3;
        const severity = sevMap[adoSeverity] || priMap[adoPriority] || 'medium';

        return {
            adoId: wi.id,
            adoUrl: `${org.orgUrl}/${org.project}/_workitems/edit/${wi.id}`,
            orgId: org.id,
            title: f['System.Title'] || `Work Item #${wi.id}`,
            description: this._stripHtml(f['System.Description'] || ''),
            state: f['System.State'] || 'Unknown',
            type: f['System.WorkItemType'] || 'Bug',
            severity,
            assignedTo: f['System.AssignedTo']?.displayName || 'Unassigned',
            createdBy: createdByIdentity?.displayName || (typeof createdByIdentity === 'string' ? createdByIdentity : ''),
            createdByEmail: createdByEmails[0] || this._normalizeEmail(createdByIdentity?.uniqueName || createdByIdentity?.mailAddress || ''),
            createdByEmails,
            tags: f['System.Tags'] || '',
            area: f['System.AreaPath'] || '',
            createdDate: f['System.CreatedDate'],
            changedDate: f['System.ChangedDate']
        };
    },

    _stripHtml(html) {
        return html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    // ── Post a comment back to a work item ──
    async postComment(org, workItemId, commentText) {
        if (!this.isTicketWriteEnabled()) {
            return { ok: false, error: 'Read-only mode enabled: ticket write operations are blocked.' };
        }

        const { orgUrl, project, pat } = org;
        const base = orgUrl.replace(/\/$/, '');
        const url = `${base}/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.0-preview`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': this._authHeader(pat),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text: commentText })
            });

            if (!res.ok) {
                const errText = await res.text();
                return { ok: false, error: `HTTP ${res.status}: ${errText}` };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    // ── Build a formatted patch comment for ADO ──
    buildPatchComment(workItemId, recommendations, engineType) {
        const top = recommendations[0];
        if (!top) return null;

        const date = new Date().toLocaleString();
        const engine = engineType === 'ollama' ? '🤖 Ollama LLM' : '📐 TF-IDF Engine';

        let comment = `<h3>🔧 AzurePatchAI — Patch Recommendation</h3>`;
        comment += `<p><em>Analyzed on ${date} using ${engine}</em></p>`;
        comment += `<hr/>`;

        recommendations.slice(0, 3).forEach((rec, idx) => {
            const rank = ['🥇', '🥈', '🥉'][idx] || `#${idx + 1}`;
            comment += `<p><strong>${rank} ${rec.patch.name}</strong> — Confidence: ${rec.confidence}%</p>`;
            if (rec.reasoning) {
                comment += `<p><em>${rec.reasoning}</em></p>`;
            }
            comment += `<p>${rec.patch.description}</p>`;
            comment += `<p>⚠ Risk: ${rec.patch.riskLevel} | ⏱ Est. time: ${rec.patch.estimatedTime}</p>`;
            if (rec.patch.steps?.length) {
                comment += `<p><strong>Resolution Steps:</strong></p><ol>`;
                rec.patch.steps.forEach(s => { comment += `<li><code>${s}</code></li>`; });
                comment += `</ol>`;
            }
            comment += `<hr/>`;
        });

        comment += `<p><small>Generated by <strong>AzurePatchAI</strong> — 100% offline DB patch recommendation engine</small></p>`;
        return comment;
    }
};
