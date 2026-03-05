# Recall Walkthrough Voiceover Script

## Scene 1 — Intro
Welcome to Recall. This demo shows how users integrate their organization first, then unlock the main workspace for intake, recommendations, and training.

## Scene 2 — Integration First
Users land on Recall landing page. Clicking Integrate Organization opens onboarding-only settings with only required provider credentials and Save & Activate.

## Scene 3 — Workspace Unlock
After successful integration, Recall opens the main app tabs: Intake, Recommendations, History, Analytics, and Training. If integration is missing, actions are gated and user is routed back to onboarding.

## Scene 4 — Test Data and Accuracy
For reproducible benchmarking, we generated a synthetic corpus of 270 resolved incidents across 6 patch classes.
Split: 210 train and 60 test tickets.
Measured results:
- Top-1: 73.3%
- Recall@3: 73.3%
- Recall@5: 73.3%
- MRR: 73.3%
- Abstain Rate: 26.7%

## Scene 5 — Under the Hood
Recall uses a local-first JavaScript frontend, optional provider integrations, hybrid retrieval and ranking, confidence-aware abstain behavior, and optional Python or Spring backend modes.

## Scene 6 — Outro
This walkthrough and metrics were generated directly from the current workspace artifacts.
