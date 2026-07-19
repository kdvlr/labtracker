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

# Tokens that mark a *derived / composite / negated / different* analyte. Their
# presence means the row is a distinct test that must never be folded into a
# single-analyte catalog type — only an exact name/alias match is allowed.
#
# "nucleated" earns its place the same way "non" did: NUCLEATED RED BLOOD CELLS
# is a different analyte from RED BLOOD CELLS, but "blood" is a stop word, so its
# signature {nucleated, red, cells} contains the catalog's {red, cells} and the
# token-subset rule merged the two.
_DISQUALIFY = {"non", "ratio", "index", "vldl", "nucleated"}

# A percent variant measures something different from its absolute counterpart
# ("Neutrophils %" vs "Neutrophils - Absolute Count"), but the "%" is punctuation
# and used to vanish during tokenization — so a lab's "X %" and "X" row looked
# identical and could collapse onto one another. Fold the spellings together into
# one significant token instead of dropping it.
_PERCENT = {"percent", "percentage", "pct"}


def _tokens(s: str) -> list:
    s = (s or "").lower().replace("%", " percent ")
    return [
        "percent" if t in _PERCENT else t
        for t in re.split(r"[^a-z0-9]+", s)
        if t
    ]


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


def _incompatible(tt: dict, is_qualitative: bool) -> bool:
    """True when a qualitative row cannot be this (numeric) catalog test.

    Labs print the same bare label in different panels: a Quest report carries
    "GLUCOSE  91 mg/dL" in the chemistry panel and "GLUCOSE  NEGATIVE" in the
    urinalysis section pages later. The names are byte-identical, so no amount of
    name cleverness separates them — but a dipstick "NEGATIVE" with no unit
    plainly is not a mg/dL fasting blood glucose, and folding it in puts a
    qualitative row into a numeric trend line.

    So: a text result never merges into a test type that is measured in a unit.
    This deliberately over-rejects (a urine RBC reported as "Nil" will track on
    its own rather than joining a cells/HPF series). That is the trade this
    module already makes everywhere else — an unrecognised test tracked
    separately is visible and fixable, a wrong merge silently corrupts a series.
    """
    return is_qualitative and bool((tt.get("canonical_unit") or "").strip())


def match_test_type(name: str, test_types: list,
                    is_qualitative: bool = False) -> Optional[dict]:
    """test_types is a list of dicts with keys name, slug, aliases (list).

    is_qualitative marks a row whose result is text ("NEGATIVE", "Nil") rather
    than a number; such a row will not be merged into a unit-bearing test type.
    """
    target = _norm(name)
    if not target:
        return None

    def ok(t):
        return None if (t is None or _incompatible(t, is_qualitative)) else t

    raw = _tokens(name)
    # Composite/derived rows ("TC/HDL RATIO", "NON-HDL", "VLDL", "APO B / APO A1
    # RATIO") only merge on an *exact* name/alias hit — never by fuzzy containment.
    if "/" in (name or "") or any(t in _DISQUALIFY for t in raw):
        return ok(_exact_match(target, test_types))

    # 1) exact normalized name or alias
    hit = _exact_match(target, test_types)
    if hit:
        return ok(hit)

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
    return ok(best)
