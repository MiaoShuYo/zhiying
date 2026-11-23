import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app.local_llm_config import _reclaim_stale_slot
from app.main import _extract_pdf_page

DEAD_PID = 2 ** 22 + 12345


class SlotReclaimTests(unittest.TestCase):
    """#197: stale-slot recovery must never delete a live replacement lock."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="m2v-reclaim-"))
        self.slot = self.directory / "slot-0.lock"
        self.guard = self.directory / "slot-0.reclaim"

    def tearDown(self):
        for item in self.directory.iterdir():
            item.unlink()
        self.directory.rmdir()

    def write_owner(self, token, pid, age_ms):
        self.slot.write_text(json.dumps({"token": token, "pid": pid, "createdAt": time.time() * 1000 - age_ms}), encoding="utf-8")

    def test_dead_owner_is_reclaimed_and_guard_released(self):
        self.write_owner("dead", DEAD_PID, 60_000)
        _reclaim_stale_slot(self.slot)
        self.assertFalse(self.slot.exists())
        self.assertFalse(self.guard.exists())

    def test_live_or_fresh_owner_is_kept(self):
        self.write_owner("live", os.getpid(), 60_000)
        _reclaim_stale_slot(self.slot)
        self.assertTrue(self.slot.exists())
        self.write_owner("fresh", DEAD_PID, 0)
        _reclaim_stale_slot(self.slot)
        self.assertTrue(self.slot.exists())

    def test_replacement_acquired_after_stale_check_survives(self):
        # Waiter A judged the slot stale; before it re-checks under the guard, waiter B reclaimed
        # it and acquired a new lock. A must not delete B's lock.
        self.write_owner("dead", DEAD_PID, 60_000)
        import app.local_llm_config as module
        original = module._slot_is_stale
        calls = {"count": 0}

        def stale_then_replaced(candidate):
            calls["count"] += 1
            if calls["count"] == 1:
                result = original(candidate)
                self.write_owner("replacement", os.getpid(), 0)
                return result
            return original(candidate)

        with patch.object(module, "_slot_is_stale", side_effect=stale_then_replaced):
            _reclaim_stale_slot(self.slot)
        self.assertEqual("replacement", json.loads(self.slot.read_text(encoding="utf-8"))["token"])

    def test_other_reclaimer_holding_guard_blocks_unlink(self):
        self.write_owner("dead", DEAD_PID, 60_000)
        self.guard.write_text("", encoding="utf-8")
        _reclaim_stale_slot(self.slot)
        self.assertTrue(self.slot.exists())
        self.assertTrue(self.guard.exists())


class _FakePage:
    def __init__(self, text):
        self._text = text

    def get_images(self):
        return [("logo",)]

    def get_text(self, *args, **kwargs):
        return self._text


class PdfOcrFallbackTests(unittest.TestCase):
    """#318: missing OCR must not discard a page's readable native text."""

    def test_native_text_kept_when_ocr_missing(self):
        with patch("app.main._ocr_data_dir", return_value=None), patch("app.main._page_table_count", return_value=0):
            result = _extract_pdf_page(_FakePage("第一章 简介"), 1)
        self.assertNotIn("error", result)
        self.assertEqual("第一章 简介", result["text"])
        self.assertEqual("text", result["method"])
        self.assertTrue(any("Tesseract" in warning for warning in result["warnings"]))

    def test_empty_page_still_reports_missing_ocr(self):
        with patch("app.main._ocr_data_dir", return_value=None), patch("app.main._page_table_count", return_value=0):
            result = _extract_pdf_page(_FakePage(""), 2)
        self.assertIn("Tesseract", result.get("error", ""))

    def test_forced_ocr_without_tesseract_is_an_error(self):
        with patch("app.main._ocr_data_dir", return_value=None), patch("app.main._page_table_count", return_value=0):
            result = _extract_pdf_page(_FakePage("第一章 简介"), 3, force_ocr=True)
        self.assertIn("Tesseract", result.get("error", ""))


if __name__ == "__main__":
    unittest.main()
