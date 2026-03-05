# Recall Demo Video Artifacts

This folder contains an auto-generated walkthrough video for Recall:

- `recall_walkthrough.mp4` — 42s demo video
- `voiceover_script.md` — narration text for the video
- `demo_summary.json` — machine-readable summary
- `frames/` — rendered slide frames used to build the video

## What the video covers

1. Landing + integration-first onboarding
2. Unlocking main app after successful org integration
3. Intake/recommendation/training flow
4. Synthetic dataset benchmark and measured accuracy
5. Under-the-hood architecture (frontend + retrieval + backend options)

## Data used for measured accuracy

- Database: `backend/data/demo_recommendation.db`
- Split: `backend/data/demo_split/train_ids.json`, `backend/data/demo_split/test_ids.json`
- Accuracy report: `backend/data/demo_accuracy_report.json`

The benchmark dataset is synthetic and intended for reproducible demo/testing.
