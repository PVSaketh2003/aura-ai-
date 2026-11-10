"""Exact arithmetic for spoken or typed calculations ("99 plus 89 into 2 is equal to how much?", "25 गुणा 4",
"100 మైనస్ 37"). A 4B LLM gets multi-step arithmetic wrong and retrieval has nothing to find, so Aura computes the
result itself with a whitelist AST evaluator (no eval of user text) and hands the LLM the exact answer to explain.

Operator precedence is the standard one (× and ÷ before + and −); the interpreted expression is shown to the user so
an ambiguous spoken order ("… plus 59 into 2") is visible rather than hidden.
"""
from __future__ import annotations

import ast
import operator
import re
from dataclasses import dataclass

# Spoken / written operator words → symbols. Longer phrases first.
_WORDS = [
    (r"to the power of|raised to|power", "**"),
    (r"multiplied by|times|into|गुणा|गुणे|इनटू|इंटू|ఇంటు|ఇంటూ|గుణించి|గుణకారం", "*"),
    (r"divided by|over|भाग|डिवाइडेड बाय|భాగించి|డివైడెడ్ బై", "/"),
    (r"plus|add|जमा|प्लस|और|ప్లస్|కలిపి", "+"),
    (r"minus|less|subtract|माइनस|घटा|ఘటా|మైనస్|తీసివేస్తే", "-"),
    (r"modulo|mod", "%"),
    (r"×|x(?=\s*\d)", "*"), (r"÷", "/"), (r"\^", "**"),
]
_DIGITS = str.maketrans("०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯", "01234567890123456789")
_CUE = re.compile(r"\b(how much|equals?|equal to|calculate|compute|what(?:'s| is)|sum|total|result)\b|=|\?|"
                  r"कितना|बराबर|गणना|ఎంత|సమానం|లెక్క", re.I)
_STRONG_CUE = re.compile(r"\b(how much|equals?|equal to|calculate|compute|sum|total)\b|=|कितना|बराबर|गणना|ఎంత|సమానం|లెక్క", re.I)
_RANGE = re.compile(r"^\s*\d+\s*[-/]\s*\d+\s*$")  # "2019-2020", "3/4", "2-3": a range, date or fraction
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Mod: operator.mod, ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos}


@dataclass
class Calculation:
    expression: str  # human-readable, e.g. "99 + 89 + 79 − 69 + 59 × 2 + 0"
    result: float | int

    def as_dict(self) -> dict:
        return {"expression": self.expression, "result": self.result}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        a, b = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and (abs(b) > 64 or abs(a) > 1e6):
            raise ValueError("exponent too large")
        return _OPS[type(node.op)](a, b)
    raise ValueError("not arithmetic")


def detect(text: str) -> Calculation | None:
    """The arithmetic expression in the text and its exact value, or None if the text isn't a calculation."""
    t = text.translate(_DIGITS).replace(",", "")
    for pat, sym in _WORDS:
        t = re.sub(rf"(?<=[\d\s)])\s*(?:{pat})\s*(?=[\d\s(-])", f" {sym} ", t, flags=re.I)
    # the longest run of numbers, operators and brackets
    runs = re.findall(r"[\d(][\d\s.+\-*/%()]*[\d)]", t)
    best = max(runs, key=len, default="")
    nums = re.findall(r"\d+(?:\.\d+)?", best)
    ops = re.findall(r"\*\*|[+\-*/%]", best)
    if len(nums) < 2 or not ops:
        return None
    # A bare range or date ("2019-2020", "3/4 of the chapters") is not a request to calculate.
    words = len(re.findall(r"[^\W\d_]+", t))
    if not (_CUE.search(text) or words <= 2):
        return None
    expr = re.sub(r"\s+", " ", best).strip()
    if _RANGE.match(expr) and not _STRONG_CUE.search(text):
        return None
    try:
        value = _eval(ast.parse(expr, mode="eval"))
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError, TypeError):
        return None
    if isinstance(value, float):
        value = int(value) if value.is_integer() else round(value, 10)
    pretty = expr.replace("**", "^").replace("*", "×").replace("/", "÷").replace("-", "−")
    pretty = re.sub(r"\s*([×÷+−^%])\s*", r" \1 ", pretty).strip()
    return Calculation(pretty, value)
