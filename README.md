GV-Legacy General Mod (Discord bot)

**Word list & trigger radar**
- `words.txt` – main trigger words (comma-separated).
- `words-variants.txt` – synonyms, abbreviations, misspellings, leetspeak (e.g. `relig`, `g0d`, `jeezus`, `pol`, `gov`, `j3sus`). Loaded in addition to `words.txt`.
- Matching also uses **normalization**: repeated letters are collapsed (`goooood` → `god`) and common number-for-letter substitutions (e.g. `0→o`, `1→i`, `3→e`, `4→a`) so `g0d`, `pol1t1cs`, `w4r` and prolonged spellings still trigger. Add more variants in `words-variants.txt` or set `WORDS_VARIANTS_FILE` to another path.
