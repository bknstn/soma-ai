"""Pinned native startup bridge; a disabled/unloaded plugin cannot start a timer."""


async def handle(event_type, context):
    if event_type != "gateway:startup":
        return
    from gateway.run import _gateway_runner_ref
    from hermes_cli.plugins import get_plugin_manager
    manager = get_plugin_manager()
    loaded = manager._plugins.get("soma-assistant")
    if loaded is not None and loaded.enabled and not loaded.error and loaded.module is not None:
        loaded.module.assistant.start(_gateway_runner_ref())
