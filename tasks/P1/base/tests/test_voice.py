"""口播按短语找时间：Voice.span / at / end_of。逐字时间戳是假的（不调语音合成接口），格式同 ElevenLabs 带时间戳的配音。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hfcut import Voice, Word, _words  # noqa: E402


def alignment(text, step=0.1):
    """每个字符一个时间段：第 i 个字符从 i*step 到 i*step+0.08"""
    return {"characters": list(text),
            "character_start_times_seconds": [round(i * step, 3) for i in range(len(text))],
            "character_end_times_seconds": [round(i * step + 0.08, 3) for i in range(len(text))]}


def voice(text):
    return Voice(Path("vo.mp3"), _words(alignment(text)), len(text) * 0.1)


class WordsTest(unittest.TestCase):
    def test_words_split_on_spaces(self):
        ws = _words(alignment("Pack it in ten seconds."))
        self.assertEqual([w.text for w in ws], ["Pack", "it", "in", "ten", "seconds."])
        self.assertEqual((ws[0].start, ws[0].end), (0.0, 0.38))
        self.assertEqual((ws[1].start, ws[1].end), (0.5, 0.68))

    def test_clean_strips_punctuation_and_case(self):
        self.assertEqual(Word("“Done!”", 0, 0).clean, "done")
        self.assertEqual(Word("it,", 0, 0).clean, "it")


class SpanTest(unittest.TestCase):
    def test_span_finds_phrase(self):
        vo = voice("Snap a photo and it names the item.")
        self.assertEqual(vo.span("names the item"), (2.0, 3.48))
        self.assertEqual(vo.at("snap a photo"), 0.0)
        self.assertEqual(vo.end_of("photo"), 1.18)

    def test_span_ignores_punctuation_and_case(self):
        vo = voice("Ready? Tap Done, and you are packed!")
        self.assertEqual(vo.span("tap done"), (0.7, 1.58))
        self.assertEqual(vo.span("Packed."), (2.9, 3.58))

    def test_span_after(self):
        vo = voice("Tap once. Then tap once more.")
        self.assertEqual(vo.at("tap once"), 0.0)
        self.assertEqual(vo.at("tap once", after=0.5), 1.5)

    def test_missing_phrase_raises(self):
        with self.assertRaises(KeyError):
            voice("Pack it in ten seconds.").span("pack it now")


if __name__ == "__main__":
    unittest.main()
