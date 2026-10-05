# Privacy notes

Sensory Firewall can process camera frames, microphone audio, transcripts, and task metadata.

## Local data

The prototype can locally store:

- settings;
- estimated usage totals;
- task archive titles/tags;
- raw transcript chunks in task archives;
- AI decision records.

## Cloud data

When cloud analysis is enabled, selected audio/image content and context are sent to the configured model provider. Users should not run the app where recording is prohibited or where bystanders reasonably expect privacy.

## Temporary media

The app attempts to delete temporary captured media after an analysis attempt. This is an application-level best effort, not a formal forensic-erasure guarantee.

## Public repository rule

Never commit real archives, recordings, API keys, or user-specific trigger words to the public repository.
