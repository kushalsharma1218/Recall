# Recall

Recall is a local-first incident code resolution app that recommends fixes from previously resolved tickets and trained code changes.

## Current Product Direction

- UX-first flow with fast local interactions.
- Dedicated landing experience (`index.html`) shown before workspace entry.
- Information pages: `about.html`, `contact.html`, and `contributors.html`.
- Organization integration is available from **Settings** (`Azure DevOps` / `Jira`) for sync and training.
- Main workspace is unlocked after integration is configured.

## Backend Direction

- Java backend only (`spring-backend`) is the active path going forward.
- Legacy Python backend is excluded from this git repository.

## Run

1. Frontend (from project root):
```bash
npx http-server . -p 4173
```

2. Java backend:
```bash
cd spring-backend
mvn spring-boot:run
```

3. In UI settings, backend URL:
- `http://127.0.0.1:8080`
