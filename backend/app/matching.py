"""Match an extracted test name to a known test_type by name/alias.

Matching is deliberately conservative: a wrong auto-merge silently corrupts a
series (e.g. "NON-HDL CHOLESTEROL" landing in the "HDL Cholesterol" chart), which
is far worse than tracking an unrecognised test on its own. So we only merge when
we are confident, and anything ambiguous falls through to "track as new".
"""
import re
from typing import Optional

# Method / specimen modifiers that don't change *what* is measured — dropped
# before comparing, so "HDL CHOLESTEROL - DIRECT" still matches "HDL Cholesterol".
_STOP = {
    "s", "se", "serum", "plasma", "blood", "level", "levels", "test", "direct",
    "measured", "calc", "calculated", "estimated", "fasting",
}

# Tokens that mark a *derived / composite / negated* analyte. Their presence means
# the row is a distinct test that must never be folded into a single-analyte
# catalog type — only an exact name/alias match is allowed for these.
_DISQUALIFY = {"non", "ratio", "index", "vldl"}


def _tokens(s: str) -> list:
    return [t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t]


def _norm(s: str) -> str:
    return "".join(_tokens(s))


def _sig(s: str) -> set:
    return {t for t in _tokens(s) if t not in _STOP}


def _exact_match(target: str, test_types: list) -> Optional[dict]:
    for t in test_types:
        for n in [t["name"], *t.get("aliases", [])]:
            if _norm(n) == target:
                return t
    return None


def match_test_type(name: str, test_types: list) -> Optional[dict]:
    """test_types is a list of dicts with keys name, slug, aliases (list)."""
    target = _norm(name)
    if not target:
        return None

    raw = _tokens(name)
    # Composite/derived rows ("TC/HDL RATIO", "NON-HDL", "VLDL", "APO B / APO A1
    # RATIO") only merge on an *exact* name/alias hit — never by fuzzy containment.
    if "/" in (name or "") or any(t in _DISQUALIFY for t in raw):
        return _exact_match(target, test_types)

    # 1) exact normalized name or alias
    hit = _exact_match(target, test_types)
    if hit:
        return hit

    # 2) token-subset containment among simple (non-derived) names. One side's
    #    significant tokens must fully contain the other's — this lets a short lab
    #    name ("HDL") reach "HDL Cholesterol" and a modifier-suffixed name ("HDL
    #    Cholesterol - Direct") reach it too, without matching on a single shared
    #    generic token like "cholesterol" across different analytes.
    sig = _sig(name)
    if not sig:
        return None
    best = None
    best_overlap = 0
    for t in test_types:
        for c in [t["name"], *t.get("aliases", [])]:
            ctok = _sig(c)
            if not ctok:
                continue
            if sig <= ctok or ctok <= sig:
                # require the discriminating (non-generic) tokens to line up:
                # the smaller set must be fully contained, and its size is the
                # confidence — a lone generic token ("cholesterol") won't beat a
                # two-token match.
                overlap = len(sig & ctok)
                smaller = min(len(sig), len(ctok))
                if overlap == smaller and overlap > best_overlap:
                    best = t
                    best_overlap = overlap
    # A single shared token is too weak to auto-merge: "IRON" would swallow "TOTAL
    # IRON BINDING CAPACITY", "TSH" would swallow anything with tsh in it. Genuine
    # short names (HDL, IRON, TSH) already match exactly via their aliases above,
    # so the fuzzy path only fires for multi-token modifier variants — require ≥2
    # aligned tokens there. Anything weaker tracks as its own test instead.
    if best is not None and best_overlap < 2:
        return None
    return best
