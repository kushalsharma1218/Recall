// ============================================================
// integrations.js — Multi-provider ticket integration layer
// Supports provider profiles, connection testing, and sync
// ============================================================

'use strict';

const JiraService = {

    _authHeader(email, apiToken) {
        return 'Basic ' + btoa(`${email}:${apiToken}`);
    },

    _baseUrl(site) {
        return site.replace(/\/$/, '');
    },

    async testConnection(config) {
        const site = (config.site || '').trim();
        const email = (config.email || '').trim();
        const apiToken = (config.apiToken || '').trim();

        if (!site || !email || !apiToken) {
            return { ok: false, error: 'Site URL, email, and API token are required' };
        }

        const url = `${this._baseUrl(site)}/rest/api/3/myself`;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this._authHeader(email, apiToken),
                    'Accept': 'application/json'
                },
                signal: controller.signal
            });
            clearTimeout(timer);

            if (res.status === 401 || res.status === 403) {
                return { ok: false, error: 'Unauthorized — check Jira email/API token permissions' };
            }
            if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
            }

            const data = await res.json();
            return { ok: true, accountId: data.accountId, displayName: data.displayName || data.emailAddress || 'Jira user' };
        } catch (err) {
            if (err.name === 'AbortError') return { ok: false, error: 'Connection timed out — check Jira URL' };
            return { ok: false, error: err.message || 'Jira connection failed' };
        }
    },

    async fetchResolvedIssues(config, options = {}) {
        const site = (config.site || '').trim();
        const email = (config.email || '').trim();
        const apiToken = (config.apiToken || '').trim();
        const projectKey = (config.projectKey || '').trim();
        const maxResults = Math.min(100, Math.max(1, options.limit || 50));

        if (!site || !email || !apiToken || !projectKey) {
            return { ok: false, error: 'Site URL, project key, email, and API token are required' };
        }

        const jql = `project=${projectKey} AND statusCategory = Done ORDER BY updated DESC`;
        const fields = [
            'summary',
            'description',
            'labels',
            'priority',
            'status',
            'resolution',
            'created',
            'updated'
        ].join(',');
        const url = `${this._baseUrl(site)}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}`;

        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this._authHeader(email, apiToken),
                    'Accept': 'application/json'
                }
            });
            if (res.status === 401 || res.status === 403) {
                return { ok: false, error: 'Unauthorized — check Jira API token scopes' };
            }
            if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
            }

            const data = await res.json();
            const issues = (data.issues || []).map(i => this._normalizeIssue(i, site, projectKey));
            return { ok: true, items: issues, total: data.total || issues.length };
        } catch (err) {
            return { ok: false, error: err.message || 'Failed to fetch Jira issues' };
        }
    },

    _normalizeIssue(issue, site, projectKey) {
        const f = issue.fields || {};
        const pri = (f.priority?.name || '').toLowerCase();
        const sevMap = {
            highest: 'critical',
            high: 'high',
            medium: 'medium',
            low: 'low',
            lowest: 'low'
        };

        return {
            externalId: issue.key || String(issue.id),
            externalUrl: `${this._baseUrl(site)}/browse/${issue.key}`,
            title: f.summary || `Jira issue ${issue.key || issue.id}`,
            description: this._extractADFText(f.description),
            resolution: f.resolution?.name || '',
            status: f.status?.name || 'Done',
            severity: sevMap[pri] || 'medium',
            tags: Array.isArray(f.labels) ? f.labels : [],
            system: `Jira ${projectKey}`,
            createdAt: f.created || null,
            updatedAt: f.updated || null
        };
    },

    _extractADFText(adfNode) {
        if (!adfNode) return '';
        if (typeof adfNode === 'string') return adfNode;

        const parts = [];
        const walk = (node) => {
            if (!node) return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (typeof node.text === 'string') parts.push(node.text);
            if (node.type === 'hardBreak') parts.push('\n');
            if (Array.isArray(node.content)) walk(node.content);
            if (node.type === 'paragraph') parts.push('\n');
        };

        walk(adfNode);
        return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
    }
};

const TicketIntegrations = {
    PROFILES_KEY: 'azpatch_ticket_integrations',
    ACTIVE_PROFILE_KEY: 'azpatch_ticket_active_profile',
    SECRET_PREFIX: 'azpatch_ticket_secret_',

    providers: {
        azure: {
            id: 'azure',
            label: 'Azure DevOps',
            fields: [
                { key: 'orgUrl', label: 'Org URL', placeholder: 'https://dev.azure.com/your-org', type: 'url', required: true },
                { key: 'project', label: 'Project', placeholder: 'ProjectName', type: 'text', required: true },
                { key: 'pat', label: 'PAT Token', placeholder: 'Personal Access Token', type: 'password', required: true }
            ],
            async testConnection(config) {
                return AzureDevOpsService.testConnection(config.orgUrl, config.project, config.pat);
            },
            async fetchResolved(config, options = {}) {
                const orgId = AzureDevOpsService.generateOrgId(config.orgUrl, config.project);
                const org = {
                    id: orgId,
                    name: config.name || config.project,
                    orgUrl: config.orgUrl,
                    project: config.project,
                    pat: config.pat
                };
                const result = await AzureDevOpsService.fetchWorkItems(org, {
                    states: ['Resolved', 'Closed', 'Done'],
                    limit: options.limit || 50
                });
                if (!result.ok) return result;
                return {
                    ok: true,
                    items: (result.items || []).map(i => ({
                        externalId: i.adoId,
                        externalUrl: i.adoUrl,
                        title: i.title,
                        description: i.description || '',
                        resolution: i.state || 'Resolved',
                        status: i.state || 'Resolved',
                        severity: i.severity || 'medium',
                        tags: TicketIntegrations._toTagArray(i.tags),
                        system: i.area ? `Azure DevOps ${i.area}` : 'Azure DevOps',
                        createdAt: i.createdDate || null,
                        updatedAt: i.changedDate || null
                    }))
                };
            }
        },
        jira: {
            id: 'jira',
            label: 'Jira Cloud',
            fields: [
                { key: 'site', label: 'Jira Site URL', placeholder: 'https://yourcompany.atlassian.net', type: 'url', required: true },
                { key: 'projectKey', label: 'Project Key', placeholder: 'SUP', type: 'text', required: true },
                { key: 'email', label: 'Jira Email', placeholder: 'name@company.com', type: 'email', required: true },
                { key: 'apiToken', label: 'API Token', placeholder: 'Atlassian API Token', type: 'password', required: true }
            ],
            async testConnection(config) {
                return JiraService.testConnection(config);
            },
            async fetchResolved(config, options = {}) {
                return JiraService.fetchResolvedIssues(config, options);
            }
        }
    },

    _profileKey(profileId) {
        return `azpatch_ticket_imported_${profileId}`;
    },

    _safeParse(raw, fallback) {
        try { return JSON.parse(raw || JSON.stringify(fallback)); }
        catch { return fallback; }
    },

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

    _safeGetSession(key) {
        try { return sessionStorage.getItem(key); }
        catch { return null; }
    },

    _safeSetSession(key, value) {
        try {
            sessionStorage.setItem(key, value);
            return true;
        } catch {
            return false;
        }
    },

    _safeRemoveSession(key) {
        try {
            sessionStorage.removeItem(key);
            return true;
        } catch {
            return false;
        }
    },

    _secretKey(profileId, fieldKey) {
        return `${this.SECRET_PREFIX}${profileId}_${fieldKey}`;
    },

    _secretFields(providerId) {
        const provider = this.getProvider(providerId);
        return (provider?.fields || [])
            .filter(f => f.type === 'password')
            .map(f => f.key);
    },

    _extractConfig(providerId, config = {}) {
        const secretKeys = new Set(this._secretFields(providerId));
        const publicConfig = {};
        const secrets = {};

        Object.entries(config || {}).forEach(([key, value]) => {
            if (secretKeys.has(key)) {
                if (value !== undefined && value !== null && String(value).trim() !== '') secrets[key] = String(value);
            } else {
                publicConfig[key] = value;
            }
        });

        return { publicConfig, secrets };
    },

    _storeSecrets(profileId, providerId, secrets = {}) {
        const fields = this._secretFields(providerId);
        fields.forEach(field => {
            const key = this._secretKey(profileId, field);
            const value = secrets[field];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                this._safeSetSession(key, String(value));
            } else {
                this._safeRemoveSession(key);
            }
        });
    },

    _hydrateConfig(profile) {
        const cfg = { ...(profile.config || {}) };
        this._secretFields(profile.provider).forEach(field => {
            const value = this._safeGetSession(this._secretKey(profile.id, field));
            if (value) cfg[field] = value;
        });
        return cfg;
    },

    _sanitizePersistedProfiles(profiles) {
        let changed = false;
        const sanitized = (profiles || []).map(profile => {
            if (!profile || !profile.provider) return profile;
            const { publicConfig, secrets } = this._extractConfig(profile.provider, profile.config || {});
            if (Object.keys(secrets).length > 0) {
                this._storeSecrets(profile.id, profile.provider, secrets);
                changed = true;
            }
            const sameKeys = Object.keys(publicConfig).length === Object.keys(profile.config || {}).length;
            if (!sameKeys) changed = true;
            return { ...profile, config: publicConfig };
        });
        return { sanitized, changed };
    },

    _slug(str) {
        return String(str || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'profile';
    },

    _toTagArray(val) {
        if (Array.isArray(val)) return val.filter(Boolean).map(String);
        if (!val) return [];
        return String(val)
            .split(/[;,]/g)
            .map(t => t.trim())
            .filter(Boolean);
    },

    _guessPatchId(ticket) {
        const haystack = `${ticket.title || ''} ${ticket.description || ''} ${(ticket.tags || []).join(' ')} ${ticket.resolution || ''}`.toLowerCase();
        let bestPatch = null;
        let bestScore = 0;

        PATCH_LIBRARY.forEach(p => {
            let score = 0;
            const terms = [p.type, p.name, ...p.tags].map(v => String(v).toLowerCase());
            terms.forEach(term => {
                if (!term) return;
                if (haystack.includes(term)) score += term.includes(' ') ? 2 : 1;
            });
            if (score > bestScore) {
                bestPatch = p.id;
                bestScore = score;
            }
        });

        return bestScore >= 2 ? bestPatch : null;
    },

    getProviders() {
        return Object.values(this.providers).map(p => ({ id: p.id, label: p.label }));
    },

    getProvider(providerId) {
        return this.providers[providerId] || null;
    },

    listProfiles() {
        let raw = '[]';
        try { raw = localStorage.getItem(this.PROFILES_KEY) || '[]'; }
        catch { raw = '[]'; }
        const parsed = this._safeParse(raw, []);
        const { sanitized, changed } = this._sanitizePersistedProfiles(parsed);
        if (changed) this._safeSetLocal(this.PROFILES_KEY, JSON.stringify(sanitized));
        return sanitized;
    },

    getProfile(profileId) {
        const profile = this.listProfiles().find(p => p.id === profileId) || null;
        if (!profile) return null;
        return { ...profile, config: this._hydrateConfig(profile) };
    },

    saveProfile(profile) {
        const { publicConfig, secrets } = this._extractConfig(profile.provider, profile.config || {});
        const persisted = { ...profile, config: publicConfig };
        const profiles = this.listProfiles();
        const idx = profiles.findIndex(p => p.id === persisted.id);
        if (idx >= 0) profiles[idx] = persisted;
        else profiles.push(persisted);
        if (!this._safeSetLocal(this.PROFILES_KEY, JSON.stringify(profiles))) {
            throw new Error('Unable to save profile (storage full or blocked).');
        }
        this._storeSecrets(persisted.id, persisted.provider, secrets);
        return persisted;
    },

    createOrUpdateProfile(input) {
        const provider = this.getProvider(input.provider);
        if (!provider) throw new Error(`Unsupported provider: ${input.provider}`);

        const name = (input.name || provider.label).trim();
        const existingId = input.id || '';
        const id = existingId || `${input.provider}_${this._slug(name)}`;

        const profile = {
            id,
            name,
            provider: input.provider,
            config: { ...(input.config || {}) },
            createdAt: input.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastSync: input.lastSync || null
        };

        this.saveProfile(profile);
        return this.getProfile(id) || profile;
    },

    deleteProfile(profileId) {
        const profile = this.getProfile(profileId);
        const profiles = this.listProfiles().filter(p => p.id !== profileId);
        this._safeSetLocal(this.PROFILES_KEY, JSON.stringify(profiles));
        this._safeRemoveLocal(this._profileKey(profileId));
        if (profile) this._storeSecrets(profileId, profile.provider, {});

        if (this.getActiveProfileId() === profileId) {
            this._safeRemoveLocal(this.ACTIVE_PROFILE_KEY);
            if (typeof FeedbackStore !== 'undefined') FeedbackStore.setOrgNamespace('default');
        }
    },

    setActiveProfile(profileId) {
        if (!this._safeSetLocal(this.ACTIVE_PROFILE_KEY, profileId)) {
            throw new Error('Unable to set active profile (storage blocked).');
        }
        if (typeof FeedbackStore !== 'undefined') FeedbackStore.setOrgNamespace(profileId || 'default');
    },

    getActiveProfileId() {
        try { return localStorage.getItem(this.ACTIVE_PROFILE_KEY) || null; }
        catch { return null; }
    },

    getActiveProfile() {
        const id = this.getActiveProfileId();
        return id ? this.getProfile(id) : null;
    },

    getImportedTickets(profileId) {
        const pid = profileId || this.getActiveProfileId();
        if (!pid) return [];
        try {
            return this._safeParse(localStorage.getItem(this._profileKey(pid)), []);
        } catch {
            return [];
        }
    },

    getAllImportedTickets() {
        return this.listProfiles().flatMap(p => this.getImportedTickets(p.id));
    },

    _saveImportedTickets(profileId, tickets) {
        return this._safeSetLocal(this._profileKey(profileId), JSON.stringify(tickets));
    },

    async testProfile(input) {
        const provider = this.getProvider(input.provider);
        if (!provider) return { ok: false, error: 'Unknown provider' };
        return provider.testConnection(input.config || {});
    },

    async syncProfile(profileId, options = {}) {
        try {
            const profile = this.getProfile(profileId);
            if (!profile) return { ok: false, error: 'Profile not found' };

            const provider = this.getProvider(profile.provider);
            if (!provider) return { ok: false, error: `Unsupported provider: ${profile.provider}` };

            const missingRequired = (provider.fields || [])
                .filter(f => f.required && !(profile.config?.[f.key] || '').trim())
                .map(f => f.label);
            if (missingRequired.length) {
                return {
                    ok: false,
                    error: `Missing required credentials/config (${missingRequired.join(', ')}). Open Settings and update this profile.`
                };
            }

            const result = await provider.fetchResolved(profile.config, options);
            if (!result.ok) return result;

            const normalized = (result.items || []).map(item => {
                const tags = this._toTagArray(item.tags);
                const patchId = this._guessPatchId(item);
                return {
                    id: `EXT-${profile.provider.toUpperCase()}-${item.externalId}`,
                    sourceProfileId: profile.id,
                    sourceProvider: profile.provider,
                    sourceUrl: item.externalUrl || '',
                    title: item.title || `Imported ticket ${item.externalId}`,
                    description: item.description || '',
                    severity: item.severity || 'medium',
                    system: item.system || provider.label,
                    tags,
                    resolvedPatch: patchId,
                    outcome: 'resolved',
                    resolutionTime: 0,
                    feedbackRating: 4,
                    importedAt: new Date().toISOString(),
                    status: 'resolved'
                };
            });

            if (!this._saveImportedTickets(profile.id, normalized)) {
                return { ok: false, error: 'Unable to store synced tickets (storage full or blocked).' };
            }
            this.saveProfile({ ...profile, lastSync: new Date().toISOString(), updatedAt: new Date().toISOString() });

            return {
                ok: true,
                imported: normalized.length,
                withMappedPatch: normalized.filter(t => !!t.resolvedPatch).length
            };
        } catch (err) {
            return { ok: false, error: err.message || 'Sync failed' };
        }
    }
};
