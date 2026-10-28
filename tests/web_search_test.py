"""Offline tests using the pinned provider ABC and synthetic HTTP/config collaborators."""

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/hermes-agent"))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load("soma_search", ROOT / "runtimes/hermes/plugins/soma-openai-search/__init__.py")


def response_fixture():
    return {"status": "completed", "output": [
        {"type": "web_search_call", "status": "completed"},
        {"type": "message", "content": [{"type": "output_text", "text": "Synthetic findings.",
            "annotations": [
                {"type": "url_citation", "url": "https://example.com/research", "title": "Research"},
                {"type": "url_citation", "url": "https://example.com/research", "title": "Duplicate"},
                {"type": "url_citation", "url": "https://example.org/study", "title": "Study"},
                {"type": "url_citation", "url": "javascript:invalid", "title": "Invalid"},
            ]}]}]}


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.config = {"web": {}}
        config_module = types.ModuleType("hermes_cli.config")
        config_module.load_config_readonly = lambda: copy.deepcopy(self.config)
        interrupt_module = types.ModuleType("tools.interrupt")
        interrupt_module.is_interrupted = Mock(return_value=False)
        self.http = types.ModuleType("httpx")
        self.http.TimeoutException = type("TimeoutException", (Exception,), {})
        self.http.post = Mock(return_value=Mock(status_code=200, json=Mock(return_value=response_fixture())))
        self.modules = patch.dict(sys.modules, {
            "hermes_cli.config": config_module, "tools.interrupt": interrupt_module, "httpx": self.http})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.key = patch.object(plugin, "get_provider_env", return_value="SYNTHETIC_API_KEY")
        self.key.start()
        self.addCleanup(self.key.stop)
        self.provider = plugin.OpenAIWebSearchProvider()
        self.interrupt = interrupt_module.is_interrupted

    def test_registration_and_capabilities(self):
        context = Mock()
        plugin.register(context)
        provider = context.register_web_search_provider.call_args.args[0]
        self.assertEqual(provider.name, "soma-openai")
        self.assertTrue(provider.supports_search())
        self.assertFalse(provider.supports_extract())
        self.assertTrue(provider.is_available())
        self.http.post.assert_not_called()

    def test_request_uses_same_key_fixed_endpoint_and_query_only(self):
        self.config["web"]["openai"] = {"model": "synthetic-search-model"}
        result = self.provider.search("  synthetic public research  ", 1)
        self.assertTrue(result["success"])
        args, kwargs = self.http.post.call_args
        self.assertEqual(args, ("https://api.openai.com/v1/responses",))
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer SYNTHETIC_API_KEY")
        self.assertFalse(kwargs["follow_redirects"])
        self.assertFalse(kwargs["trust_env"])
        payload = kwargs["json"]
        self.assertEqual(payload["model"], "synthetic-search-model")
        self.assertEqual(payload["input"], "synthetic public research")
        self.assertEqual(payload["tools"], [{"type": "web_search"}])
        self.assertEqual(payload["tool_choice"], "required")
        self.assertFalse(payload["store"])
        self.assertNotIn("SYNTHETIC_API_KEY", json.dumps(payload))
        self.assertEqual(len(result["data"]["web"]), 1)
        self.assertEqual(result["data"]["web"][0]["url"], "https://example.com/research")

    def test_sources_are_deduplicated_and_keep_summary(self):
        hits = self.provider.search("synthetic")['data']['web']
        self.assertEqual(len(hits), 2)
        self.assertEqual([hit["position"] for hit in hits], [1, 2])
        self.assertEqual(hits[0]["description"], "Synthetic findings.")

    def test_missing_key_empty_query_and_interrupt_make_no_request(self):
        with patch.object(plugin, "get_provider_env", return_value=""):
            self.assertFalse(self.provider.is_available())
            self.assertIn("OPENAI_API_KEY", self.provider.search("synthetic")["error"])
        self.assertFalse(self.provider.search(" ")["success"])
        self.interrupt.return_value = True
        self.assertEqual(self.provider.search("synthetic")["error"], "Interrupted")
        self.http.post.assert_not_called()

    def test_http_errors_timeouts_and_malformed_responses_are_redacted(self):
        for status in (401, 429, 500, 302):
            self.http.post.return_value = Mock(status_code=status, text="SYNTHETIC_PRIVATE_BODY")
            result = self.provider.search("synthetic")
            self.assertIn(str(status), result["error"])
            self.assertNotIn("SYNTHETIC_PRIVATE", json.dumps(result))
        for error in (self.http.TimeoutException("SYNTHETIC_PRIVATE"), ValueError("SYNTHETIC_PRIVATE")):
            self.http.post.side_effect = error
            result = self.provider.search("synthetic")
            self.assertFalse(result["success"])
            self.assertNotIn("SYNTHETIC_PRIVATE", json.dumps(result))
        self.http.post.side_effect = None
        self.http.post.return_value = Mock(status_code=200, json=Mock(return_value=[]))
        self.assertFalse(self.provider.search("synthetic")["success"])

    def test_no_search_incomplete_and_uncited_answers_fail(self):
        for value in ({"status": "incomplete"}, {"status": "completed", "output": []},
                      {"status": "completed", "output": [{"type": "web_search_call", "status": "completed"}]}):
            self.http.post.return_value = Mock(status_code=200, json=Mock(return_value=value))
            self.assertFalse(self.provider.search("synthetic")["success"])


class InstallTest(unittest.TestCase):
    def setUp(self):
        # JSON is a YAML subset. The installed-runtime integration checks Hermes YAML
        # and Hermes discovery; this substitute keeps unit tests dependency-free.
        yaml_module = types.ModuleType("hermes_yaml")
        yaml_module.safe_load = json.loads
        yaml_module.safe_dump = lambda config, stream, **kwargs: json.dump(config, stream)
        with patch.dict(sys.modules, {"hermes_yaml": yaml_module}):
            self.installer = load("soma_install", ROOT / "runtimes/hermes/install-web-search.py")
        self.temp = tempfile.TemporaryDirectory(prefix="soma-web-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.source = ROOT / "runtimes/hermes/plugins/soma-openai-search"

    def test_fresh_install_is_idempotent_and_preserves_settings(self):
        self.installer.install(self.source, self.home)
        config_file = self.home / "config.yaml"
        config = json.loads(config_file.read_text())
        self.assertEqual(config["web"]["search_backend"], "soma-openai")
        self.assertFalse(config["web"]["keyless_rescue"])
        self.assertEqual(config["plugins"]["enabled"], ["soma-openai-search"])
        config["model"] = {"provider": "openai-api", "default": "synthetic-model"}
        config["plugins"]["enabled"].append("other-plugin")
        config["web"]["search_backend"] = "other-backend"
        config_file.write_text(json.dumps(config))
        self.installer.install(self.source, self.home)
        self.assertEqual(json.loads(config_file.read_text()), config)
        self.assertEqual(config_file.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.home.glob(".soma-web-*")))
        target = self.home / "plugins/soma-openai-search/__init__.py"
        self.assertEqual(target.read_bytes(), (self.source / "__init__.py").read_bytes())

    def test_shared_backend_and_disabled_plugin_are_preserved(self):
        config = {"web": {"backend": "other-backend"}, "plugins": {"disabled": ["soma-openai-search"]}}
        (self.home / "config.yaml").write_text(json.dumps(config))
        self.installer.install(self.source, self.home)
        result = json.loads((self.home / "config.yaml").read_text())
        self.assertNotIn("search_backend", result["web"])
        self.assertNotIn("soma-openai-search", result["plugins"]["enabled"])

    def test_symlink_and_invalid_config_are_rejected_without_overwrite(self):
        outside = self.home / "untouched"
        outside.write_text("synthetic")
        config_file = self.home / "config.yaml"
        config_file.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.installer.install(self.source, self.home)
        self.assertEqual(outside.read_text(), "synthetic")
        config_file.unlink()
        config_file.write_text("[]")
        with self.assertRaises(ValueError):
            self.installer.install(self.source, self.home)
        self.assertEqual(config_file.read_text(), "[]")

    def test_failed_config_write_cleans_temporary_file(self):
        config_file = self.home / "config.yaml"
        config_file.write_text("{}")
        with patch.object(self.installer.yaml, "safe_dump", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                self.installer.install(self.source, self.home)
        self.assertEqual(config_file.read_text(), "{}")
        self.assertFalse(list(self.home.glob(".soma-web-*")))


if __name__ == "__main__":
    unittest.main()
