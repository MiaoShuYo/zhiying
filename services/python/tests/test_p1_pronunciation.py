import unittest

from fastapi.testclient import TestClient

from app.main import app


class PronunciationValidateTests(unittest.TestCase):
    """#316: the Web app checks readings with the same validator synthesis uses."""

    def setUp(self):
        self.client = TestClient(app)

    def test_valid_reading_is_accepted(self):
        response = self.client.post("/pronunciation/validate", json={"rules": [{"text": "行", "pinyin": ["hang2"]}]})
        self.assertEqual(200, response.status_code)

    def test_reading_that_does_not_belong_to_the_character_is_rejected(self):
        response = self.client.post("/pronunciation/validate", json={"rules": [{"text": "行", "pinyin": ["ma3"]}]})
        self.assertEqual(400, response.status_code)
        self.assertIn("行", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
