"""Start the pinned classic CLI with private scheduled Curator reports."""

import sys
from contextlib import suppress
from pathlib import Path


def run_scheduled_review(_cli):
    with suppress(Exception):
        from agent.curator import maybe_run_curator

        maybe_run_curator(idle_for_seconds=float("inf"))


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "third_party" / "hermes-agent"))

    from hermes_cli.main import main as hermes_main
    from hermes_cli.cli_tui_runtime_mixin import CLITuiRuntimeMixin

    # Keep the pinned CLI's background thread and Curator's native cadence,
    # locks and private reports. Omit the callback that prints into the REPL.
    CLITuiRuntimeMixin._run_startup_maintenance = run_scheduled_review
    hermes_main()


if __name__ == "__main__":
    main()
