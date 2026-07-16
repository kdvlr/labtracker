"""Unit conversion into a test type's canonical unit.

Each test type stores a `conversions` map: unit -> {"factor": f, "offset": o},
where canonical_value = raw_value * f + o. The canonical unit maps to factor 1.
Unit strings are matched case-insensitively and tolerant of common variants
(micro sign vs 'u', spacing).
"""
import re
from typing import Optional


def _normalize(unit: str) -> str:
    if unit is None:
        return ""
    u = unit.strip().lower()
    u = u.replace("µ", "u").replace("μ", "u")
    u = u.replace(" ", "")
    return u


def to_number(value) -> Optional[float]:
    """Best-effort parse of a lab value into a float.

    Handles ints/floats, numeric strings, thousands separators ("1,234"),
    unicode minus, trailing whitespace, and leading comparators ("<5", ">120").
    Returns None when there is no parseable number, so a single unusual cell
    can never crash extraction — the row is skipped instead.
    """
    if value is None:
        return None
    if isinstance(value, bool):  # guard: bool is an int subclass
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    s = s.replace("−", "-").replace(" ", "")
    # Strip thousands separators ("1,234,567") but leave a lone comma alone so we
    # don't turn a decimal comma "5,5" into "55".
    s = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", s)
    s = s.lstrip("<>=~≤≥")
    m = re.match(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def find_conversion(conversions: dict, unit: str) -> Optional[dict]:
    target = _normalize(unit)
    for key, spec in conversions.items():
        if _normalize(key) == target:
            return spec
    return None


def to_canonical(value, unit: str, canonical_unit: str, conversions: dict) -> Optional[float]:
    """Convert `value` given in `unit` into the canonical unit.

    Returns None when `value` isn't numeric or the unit is unknown for this
    test type (so the caller can skip that one row without failing the report).
    """
    num = to_number(value)
    if num is None:
        return None
    nu, nc = _normalize(unit), _normalize(canonical_unit)
    # Same unit — or either side is unitless — means no conversion is needed. A
    # unitless value for a known test is assumed to already be in the canonical
    # unit; accepting it as-is beats silently dropping the datapoint. A wrong
    # *non-empty* unit still returns None below and is surfaced to the user.
    if nu == nc or nu == "" or nc == "":
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


def compute_flag(value_canonical: float, ref_low: Optional[float], ref_high: Optional[float]) -> Optional[str]:
    if value_canonical is None:
        return None
    if ref_low is not None and value_canonical < ref_low:
        return "L"
    if ref_high is not None and value_canonical > ref_high:
        return "H"
    return None
