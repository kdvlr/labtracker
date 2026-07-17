"""Unit conversion into a test type's canonical unit.

Each test type stores a `conversions` map: unit -> {"factor": f, "offset": o},
where canonical_value = raw_value * f + o. The canonical unit maps to factor 1.
Unit strings are matched case-insensitively and tolerant of common variants
(micro sign vs 'u', spacing).
"""
import re
from typing import Optional, Tuple


def _normalize(unit: str) -> str:
    if unit is None:
        return ""
    u = unit.strip().lower()
    u = u.replace("µ", "u").replace("μ", "u")
    u = u.replace(" ", "")
    return u


_NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


def _strip_group_separators(s: str) -> str:
    """Normalize thousands/decimal separators into a plain '.' decimal.

    Ambiguity is resolved conservatively: a *single* dot is always a decimal
    point ("1.234" is 1.234, never 1234), because silently turning a creatinine
    of 1.234 mg/dL into 1234 would be catastrophic. Dots are only treated as
    thousands separators when there are at least two groups ("1.234.567").
    """
    has_dot, has_comma = "." in s, "," in s
    if has_dot and has_comma:
        # Whichever appears last is the decimal separator; the other groups.
        if s.rfind(",") > s.rfind("."):
            return s.replace(".", "").replace(",", ".")
        return s.replace(",", "")
    if has_comma:
        # "1,234" / "1,234,567" -> thousands. Anything else ("5,5", "5,55")
        # is a decimal comma.
        if re.fullmatch(r"[-+]?\d{1,3}(?:,\d{3})+", s):
            return s.replace(",", "")
        if s.count(",") == 1:
            return s.replace(",", ".")
        return s.replace(",", "")
    if has_dot:
        # Only multi-group dots are thousands ("1.234.567"). A lone "1.234"
        # stays a decimal.
        if re.fullmatch(r"[-+]?\d{1,3}(?:\.\d{3}){2,}", s):
            return s.replace(".", "")
        return s
    return s


def parse_value(value) -> Tuple[Optional[float], Optional[str]]:
    """Parse a lab value into (number, qualifier).

    `qualifier` is '<' or '>' when the report expressed a detection/reporting
    limit ("<0.01", ">1000") rather than a measurement. Callers must keep it:
    a non-detect is *not* the same reading as its limit, and flagging it as if
    it were would invent data. Returns (None, None) when there is no parseable
    number, so one unusual cell skips its row instead of failing the report.
    """
    if value is None or isinstance(value, bool):  # bool is an int subclass
        return None, None
    if isinstance(value, (int, float)):
        return float(value), None
    s = str(value).strip()
    if not s:
        return None, None
    s = s.replace("−", "-").replace("—", "-")
    s = s.replace(" ", "").replace(" ", "")

    qualifier = None
    m = re.match(r"^(<=|>=|≤|≥|<|>)", s)
    if m:
        tok = m.group(1)
        qualifier = "<" if tok in ("<", "<=", "≤") else ">"
        s = s[len(tok):]
    s = s.lstrip("=~")

    s = _strip_group_separators(s)
    m = _NUM_RE.search(s)
    if not m:
        return None, None
    try:
        return float(m.group(0)), qualifier
    except ValueError:
        return None, None


def to_number(value) -> Optional[float]:
    """Best-effort parse of a lab value into a float (qualifier discarded)."""
    return parse_value(value)[0]


def find_conversion(conversions: dict, unit: str) -> Optional[dict]:
    target = _normalize(unit)
    for key, spec in conversions.items():
        if _normalize(key) == target:
            return spec
    return None


def to_canonical(value, unit: str, canonical_unit: str, conversions: dict) -> Optional[float]:
    """Convert `value` given in `unit` into the canonical unit.

    Returns None when the value isn't numeric or the unit is unknown for this
    test type, so the caller can surface that row rather than store a number
    whose meaning it had to guess. Notably a *missing* unit is not treated as
    "already canonical": a bare 5.4 for a mg/dL test is far more likely to be
    an extraction miss (5.4 mmol/L glucose) than a real 5.4 mg/dL.
    """
    num = to_number(value)
    if num is None:
        return None
    nu, nc = _normalize(unit), _normalize(canonical_unit)
    if nu == nc:
        return num
    spec = find_conversion(conversions, unit)
    if spec is None:
        return None
    factor = spec.get("factor", 1)
    offset = spec.get("offset", 0)
    return num * factor + offset


def known_units(canonical_unit: str, conversions: dict) -> list:
    units = list(conversions.keys())
    if canonical_unit not in units:
        units.insert(0, canonical_unit)
    return units


def compute_flag(
    value_canonical: Optional[float],
    ref_low: Optional[float],
    ref_high: Optional[float],
    qualifier: Optional[str] = None,
) -> Optional[str]:
    """Flag a canonical value against a reference range.

    A qualified (non-detect) value only flags when the comparison is certain:
    "<5" is definitely Low only if 5 is already at/below the low bound, and can
    never be High. Anything indeterminate stays unflagged rather than guessing.
    """
    if value_canonical is None:
        return None
    if qualifier == "<":
        if ref_low is not None and value_canonical <= ref_low:
            return "L"
        return None
    if qualifier == ">":
        if ref_high is not None and value_canonical >= ref_high:
            return "H"
        return None
    if ref_low is not None and value_canonical < ref_low:
        return "L"
    if ref_high is not None and value_canonical > ref_high:
        return "H"
    return None
