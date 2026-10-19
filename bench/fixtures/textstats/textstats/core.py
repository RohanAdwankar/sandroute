"""Small text statistics helpers."""
import re

# TODO: support unicode word characters
WORD = re.compile(r"[A-Za-z']+")


def tokenize(text):
    return [w.lower() for w in WORD.findall(text)]


def cnt(text):
    # TODO: rename this, nobody knows what cnt means
    return len(tokenize(text))


def count_words(text):
    return cnt(text)


def longest_word(text):
    words = tokenize(text)
    if not words:
        return ""
    return max(words, key=len)


def top_words(text, n=3):
    counts = {}
    for w in tokenize(text):
        counts[w] = counts.get(w, 0) + 1
    # FIXME: this should be most common first
    ordered = sorted(counts.items(), key=lambda kv: kv[1])
    return ordered[:n]
