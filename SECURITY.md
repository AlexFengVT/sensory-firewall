# Security notes

Sensory Firewall is a prototype and should not be deployed as-is in a production environment.

## API credentials

The app accepts an OpenAI API key in the UI, but this public version deliberately excludes it from persisted AsyncStorage settings. The key therefore lasts only for the current app session. A production build should still not ship a long-lived provider key to the client; use a backend, short-lived credentials, or another secure architecture.

## Repository hygiene

This repository intentionally excludes:

- local Expo/runtime folders;
- npm caches;
- logs;
- recordings;
- environment files;
- local archives.

Do not commit real API keys, transcripts, recordings, screenshots containing private information, or exported AsyncStorage data.

## Reporting

If you reuse this project, treat model output as untrusted input and preserve explicit user control over actions. The current prototype does not execute destructive external actions from model output.
