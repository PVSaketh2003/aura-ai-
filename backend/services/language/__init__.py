"""Language detection and the language → engine capability map.

Rule: the answer (text and voice) uses the language the user asked in.
- Voice: the ASR engine's detected language is authoritative.
- Text: Unicode script detection (unambiguous for most Indic scripts), then statistical detection
  for Latin/Devanagari text that could be several languages.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

LANGUAGES: dict[str, str] = {
    "en": "English", "hi": "Hindi", "te": "Telugu", "ta": "Tamil", "kn": "Kannada", "ml": "Malayalam",
    "bn": "Bengali", "mr": "Marathi", "gu": "Gujarati", "pa": "Punjabi", "or": "Odia", "as": "Assamese",
    "ur": "Urdu", "ne": "Nepali", "sa": "Sanskrit", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "ja": "Japanese", "zh": "Chinese", "ar": "Arabic", "ru": "Russian",
}
INDIC = {"hi", "te", "ta", "kn", "ml", "bn", "mr", "gu", "pa", "or", "as", "ur", "ne", "sa"}

# Unicode script → language (scripts used by exactly one major language).
_SCRIPT_LANG = {
    "TELUGU": "te", "TAMIL": "ta", "KANNADA": "kn", "MALAYALAM": "ml", "GUJARATI": "gu",
    "GURMUKHI": "pa", "ORIYA": "or", "HIRAGANA": "ja", "KATAKANA": "ja", "CJK": "zh", "HANGUL": "ko",
}
_MULTI_SCRIPT = {"DEVANAGARI": "hi", "BENGALI": "bn", "ARABIC": "ar", "CYRILLIC": "ru"}


@dataclass
class DetectedLanguage:
    code: str
    name: str
    method: str
    confidence: float


def language_name(code: str) -> str:
    return LANGUAGES.get(code, code)


def _script_counts(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ch in text:
        if not ch.isalpha():
            continue
        try:
            name = unicodedata.name(ch)
        except ValueError:
            continue
        script = name.split(" ")[0]
        if script == "CJK":
            script = "CJK"
        counts[script] = counts.get(script, 0) + 1
    return counts


# Romanized Telugu / Hindi ("Naaku YOLO model training gurinchi explain cheyyi", "mujhe SVM samjhao"). Latin-script
# questions are otherwise read as English, so these function words / verb endings — which English never uses — mark
# the language. STRONG words decide alone; weak ones need company.
_ROMAN = {
    "te": {"strong": {"naaku", "naku", "nenu", "nuvvu", "meeru", "gurinchi", "cheyyi", "cheyandi", "cheppu", "cheppandi",
                      "cheppava", "cheppara", "emiti", "enti", "kavali", "unnayi", "ledhu", "konchem", "vivarinchu",
                      "vivarinchandi", "chupinchu", "chupinchandi", "istara", "ivvandi", "ivvu", "rasivvu", "telusa",
                      "enduku", "ekkada", "eppudu", "ela", "elaa", "unnav", "unnavu", "unnaru", "unnara", "bagunnava", "bagunnara", "bagundi", "emaindi", "cheyali", "cheyyali", "nerpinchu", "ardham", "artham", "manchidi", "mana", "kuda", "kooda", "chala", "chaala"},
           "weak": {"undi", "ledu", "ante", "adi", "idi", "lo", "ki", "ni", "tho", "ga", "ayina", "aithe", "kada"}},
    "hi": {"strong": {"mujhe", "mujhko", "kya", "kaise", "kaisa", "kyun", "kyon", "batao", "bataiye", "samjhao",
                      "samjhaiye", "samjha", "baare", "nahi", "nahin", "dikhao", "chahiye", "thoda", "kaun", "kitna",
                      "kahan", "kijiye", "karo", "hain", "mera", "meri", "mere", "aap", "tum", "yaar", "bhai", "acha", "accha"},
           "weak": {"hai", "ke", "ka", "ki", "ko", "mein", "se", "aur", "bhi", "par", "ye", "yeh", "wo", "woh"}},
}


def romanized_language(text: str) -> tuple[str, float] | None:
    words = re.findall(r"[a-z]+", text.lower())
    if len(words) < 2:
        return None
    best = None
    for code, lex in _ROMAN.items():
        strong = sum(w in lex["strong"] for w in words)
        weak = sum(w in lex["weak"] for w in words)
        score = strong + 0.4 * weak
        if (strong >= 2 or (strong >= 1 and weak >= 1)) and score / len(words) >= 0.12:
            if best is None or score > best[1]:
                best = (code, score)
    if not best:
        return None
    return best[0], min(0.95, 0.6 + best[1] / len(words))


def detect_text_language(text: str) -> DetectedLanguage:
    clean = re.sub(r"https?://\S+|`[^`]*`", " ", text)
    counts = _script_counts(clean)
    total = sum(counts.values())
    if not total:
        return DetectedLanguage("en", "English", "default", 0.3)
    # Code-mixed questions ("मुझे linear regression का python code दिखाओ") are mostly Latin letters but are asked in the
    # Indic language: any substantial native-script part decides the language.
    indic = {k: v for k, v in counts.items() if k in _SCRIPT_LANG or k in ("DEVANAGARI", "BENGALI", "ARABIC")}
    if indic:
        k_best, n_best = max(indic.items(), key=lambda kv: kv[1])
        if n_best >= 4 and n_best / total >= 0.12:
            counts = {k_best: n_best + total}  # force the branch below
            total = n_best + total
    script, n = max(counts.items(), key=lambda kv: kv[1])
    share = n / total
    if script in _SCRIPT_LANG and share > 0.3:
        code = _SCRIPT_LANG[script]
        return DetectedLanguage(code, language_name(code), "script", min(0.99, 0.6 + share * 0.4))
    if script in _MULTI_SCRIPT and share > 0.3:
        default = _MULTI_SCRIPT[script]
        code = _statistical(clean, allowed={"DEVANAGARI": {"hi", "mr", "ne", "sa"}, "BENGALI": {"bn", "as"},
                                            "ARABIC": {"ar", "ur", "fa"}, "CYRILLIC": {"ru", "uk"}}[script]) or default
        return DetectedLanguage(code, language_name(code), "script+statistical", 0.85)
    # Latin script: romanized Telugu/Hindi first (code-mixed with English technical words), then statistics.
    if script == "LATIN" and (rom := romanized_language(clean)):
        return DetectedLanguage(rom[0], language_name(rom[0]), "romanized", rom[1])
    # Short English questions are often misdetected, so require confidence.
    code = _statistical(clean, allowed=None, min_prob=0.9) if len(clean.split()) >= 4 else None
    code = code or "en"
    return DetectedLanguage(code, language_name(code), "statistical" if code != "en" else "latin-default", 0.8)


def _statistical(text: str, allowed: set[str] | None, min_prob: float = 0.5) -> str | None:
    try:
        from langdetect import DetectorFactory, detect_langs

        DetectorFactory.seed = 0
        for cand in detect_langs(text):
            if cand.prob < min_prob:
                continue
            if allowed is None or cand.lang in allowed:
                return cand.lang
    except Exception:
        return None
    return None


# English letter names as speech recognisers write them in Indian scripts. IndicConformer spells acronyms out
# phonetically ("SVM" → एसवीएम / ఎస్వీఎం, "PCA" → पीसीए / పీసీఏ), which embeddings and search engines don't match to the
# English acronym in a PDF. `native_acronyms` recovers them deterministically.
_LETTERS = {
    "A": ["ए", "ఏ", "ఎ"], "B": ["बी", "బీ", "బి"], "C": ["सी", "సీ", "సి"], "D": ["डी", "డీ", "డి"], "E": ["ई", "ఈ"],
    "F": ["एफ", "ఎఫ్"], "G": ["जी", "జీ", "జి"], "H": ["एच", "ఎచ్", "హెచ్"], "I": ["आई", "ఐ"], "J": ["जे", "జే"],
    "K": ["के", "కే"], "L": ["एल", "ఎల్"], "M": ["एम", "ఎం", "ఎమ్"], "N": ["एन", "ఎన్"], "O": ["ओ", "ఓ"],
    "P": ["पी", "పీ", "పి"], "Q": ["क्यू", "క్యూ"], "R": ["आर", "ఆర్"], "S": ["एस", "ఎస్"], "T": ["टी", "టీ", "టి"],
    "U": ["यू", "యూ"], "V": ["वी", "వీ", "వి"], "W": ["डब्ल्यू", "డబ్ల్యూ"], "X": ["एक्स", "ఎక్స్"], "Y": ["वाई", "వై"],
    "Z": ["जेड", "ज़ेड", "జెడ్"],
}
_LETTER_OF = sorted(((n, L) for L, names in _LETTERS.items() for n in names), key=lambda x: -len(x[0]))
# whole words that are also letter-name sequences but are ordinary words
_NOT_ACRONYM = {"केके", "एके", "ఏసీ"}


def _spell(word: str) -> str | None:
    """'एसवीएम' → 'SVM' when the word is made ONLY of ≥2 letter names; else None."""
    out, i = [], 0
    while i < len(word):
        for name, L in _LETTER_OF:
            if word.startswith(name, i):
                out.append(L)
                i += len(name)
                break
        else:
            return None
    return "".join(out) if len(out) >= 2 else None


def native_acronyms(text: str) -> list[tuple[str, str]]:
    """[(native spelling, LATIN acronym)] for acronyms written in Devanagari/Telugu letter names."""
    found = []
    for w in re.findall(r"[ऀ-ॿఀ-౿]+", text):
        if w not in _NOT_ACRONYM and (a := _spell(w)):
            found.append((w, a))
    return list(dict.fromkeys(found))
