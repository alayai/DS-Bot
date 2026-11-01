"""Protocol-independent checks for destructive semantic input boundaries."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("browser", Path(__file__).parents[1] / "broker/browser.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrowserTest(unittest.TestCase):
    def browser(self, *, field_type="text"):
        browser = module.Browser()
        state = {"tab": "tab1", "tabs": ["tab1", "tab2"], "url": "https://example.test/",
                 "nodes": [{module.ELEMENT: "node1"}],
                 "elements": [{"type": field_type, "disabled": False, "readonly": False, "tag": "input"}]}
        browser.snapshot = {"token": "snapshot1", "value": state}
        browser.capture = lambda **_args: state
        commands = []
        browser.command = lambda name, args=None: commands.append((name, args))
        return browser, commands, state

    def test_stale_and_consumed_tokens_never_dispatch(self):
        browser, commands, _ = self.browser()
        request = {"token": "old", "action": {"type": "click", "ref": "1"}}
        with self.assertRaises(module.Refused):
            browser.perform(request)
        request["token"] = "snapshot1"
        with self.assertRaises(module.Refused):
            browser.perform(request)
        self.assertEqual(commands, [])

    def test_changed_node_url_or_form_state_is_refused(self):
        for changed in ({"nodes": [{module.ELEMENT: "replacement"}]}, {"url": "https://other.test/"},
                        {"state": [{"value": "human edit"}]}, {"tab": "tab2"}):
            browser, commands, state = self.browser()
            browser.capture = lambda: {**state, **changed}
            with self.assertRaises(module.Refused):
                browser.perform({"token": "snapshot1", "action": {"type": "click", "ref": "1"}})
            self.assertEqual(commands, [])

    def test_sensitive_fields_never_dispatch(self):
        for field_type in ("password", "file"):
            browser, commands, _ = self.browser(field_type=field_type)
            with self.assertRaises(module.Refused):
                browser.perform({"token": "snapshot1", "action": {"type": "fill", "ref": "1", "text": "fixture"}})
            self.assertEqual(commands, [])

    def test_fill_uses_exact_observed_node_and_unknown_partial_input_is_not_replayed(self):
        browser, commands, _ = self.browser()
        request = {"token": "snapshot1", "action": {"type": "fill", "ref": "1", "text": "fixture"}}
        result = browser.perform(request)
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(commands, [("WebDriver:ElementClear", {"id": "node1"}),
                                    ("WebDriver:ElementSendKeys", {"id": "node1", "text": "fixture"})])
        with self.assertRaises(module.Refused):
            browser.perform(request)
        browser, commands, _ = self.browser()
        def failed(name, _args):
            commands.append(name)
            if name == "WebDriver:ElementSendKeys":
                raise RuntimeError("lost result")
        browser.command = failed
        with self.assertRaises(RuntimeError):
            browser.perform(request)
        with self.assertRaises(module.Refused):
            browser.perform(request)
        self.assertEqual(len(commands), 2)

    def test_open_rejects_unsafe_urls_before_connecting(self):
        for url in ("file:///tmp/test", "javascript:alert(1)", "https://user:secret@example.test", "http:///"):
            browser, commands, _ = self.browser()
            browser.connect = lambda **_args: self.fail("Unexpected connection")
            with self.assertRaises(module.Refused):
                browser.perform({"action": {"type": "open", "url": url}})
            self.assertEqual(commands, [])


if __name__ == "__main__":
    unittest.main()
