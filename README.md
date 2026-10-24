# Soma AI

Soma AI helps plan your next training session from workout history and sleep/recovery context already stored in Health OS. Health OS validates the context and calculates the session; a native Hermes skill lets you ask for it conversationally.

- **Recovery-aware:** prepares a session using the available recovery status and workout history.
- **Explained:** shows the session strategy, rationale, and source references.
- **Honest:** marks missing inputs and unsupported recovery instead of guessing.
- **Private by design:** keeps original records in a local Health OS workspace and passes Hermes a bounded summary, not raw health records.

The implemented workflow is manual training preparation from data already in the workspace.

## Run

After setup and workspace initialization:

```sh
npm start -- prepare-training
```

See [setup and verification](docs/getting-started.md), [Hermes setup](docs/hermes.md), [architecture](docs/architecture.md), and [privacy](docs/privacy.md).
