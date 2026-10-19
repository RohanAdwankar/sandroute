import unittest

from textstats import count_words, longest_word, tokenize, top_words


class CoreTests(unittest.TestCase):
    def test_tokenize_lowercases(self):
        self.assertEqual(tokenize("Hello, World"), ["hello", "world"])

    def test_count_words(self):
        self.assertEqual(count_words("one two  three"), 3)

    def test_longest_word(self):
        self.assertEqual(longest_word("a bbb cc"), "bbb")

    def test_top_words_most_common_first(self):
        text = "red red red blue blue green"
        self.assertEqual(top_words(text, 2), [("red", 3), ("blue", 2)])


if __name__ == "__main__":
    unittest.main()
