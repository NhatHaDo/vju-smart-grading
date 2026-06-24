"""
scorer.py
=========
Score an OMR response against an answer key.

Answer key format (dict):
    {
        "toan1":  "A",
        "toan2":  "C",
        ...
        "CCCD":   "012345678901",   # custom label (optional, skip scoring)
        ...
    }

Only labels present in the answer key and whose status is ANSWERED are scored.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.omr.field_reader import FieldResult, FieldStatus


@dataclass
class QuestionScore:
    field_label: str
    correct_answer: str
    student_answer: str | None
    is_correct: bool
    points_earned: float
    points_possible: float
    status: FieldStatus


@dataclass
class SectionScore:
    section_name: str
    labels: list[str]
    correct: int = 0
    total: int = 0
    points_earned: float = 0.0
    points_possible: float = 0.0

    @property
    def score_pct(self) -> float:
        return (self.points_earned / self.points_possible * 100) if self.points_possible > 0 else 0.0


@dataclass
class GradingReport:
    total_score: float
    max_score: float
    percentage: float
    questions: list[QuestionScore] = field(default_factory=list)
    sections: dict[str, SectionScore] = field(default_factory=dict)
    # Labels that were in the key but had OMR issues
    needs_review: list[str] = field(default_factory=list)
    # Labels in the key but not found in OMR results
    missing: list[str] = field(default_factory=list)


def score(
    field_results: dict[str, FieldResult],
    answer_key: dict[str, str],
    section_labels: dict[str, list[str]] | None = None,
    points_per_question: float = 1.0,
    skip_labels: set[str] | None = None,
) -> GradingReport:
    """
    Grade field_results against answer_key.

    Args:
        field_results:      {field_label: FieldResult} from field_reader.
        answer_key:         {field_label: correct_answer_str}.
        section_labels:     Optional grouping, e.g. {"Toán": ["toan1..15"]}.
        points_per_question: Points awarded per correct answer.
        skip_labels:        Labels to exclude from scoring (e.g. CCCD, SBD).

    Returns:
        GradingReport with per-question and per-section scores.
    """
    skip = skip_labels or set()
    questions: list[QuestionScore] = []
    needs_review: list[str] = []
    missing: list[str] = []

    total_points = 0.0
    max_points = 0.0

    for label, correct_answer in answer_key.items():
        if label in skip:
            continue

        max_points += points_per_question
        result = field_results.get(label)

        if result is None:
            missing.append(label)
            questions.append(QuestionScore(
                field_label=label,
                correct_answer=correct_answer,
                student_answer=None,
                is_correct=False,
                points_earned=0.0,
                points_possible=points_per_question,
                status=FieldStatus.INVALID,
            ))
            continue

        student_answer = result.selected_value
        is_correct = (
            result.status == FieldStatus.ANSWERED
            and student_answer == correct_answer
        )
        earned = points_per_question if is_correct else 0.0
        total_points += earned

        if result.status in (FieldStatus.MULTI_MARK, FieldStatus.TOO_LIGHT, FieldStatus.NEEDS_REVIEW):
            needs_review.append(label)

        questions.append(QuestionScore(
            field_label=label,
            correct_answer=correct_answer,
            student_answer=student_answer,
            is_correct=is_correct,
            points_earned=earned,
            points_possible=points_per_question,
            status=result.status,
        ))

    # Build section scores
    sections: dict[str, SectionScore] = {}
    if section_labels:
        for section_name, labels in section_labels.items():
            sec = SectionScore(section_name=section_name, labels=labels)
            for q in questions:
                if q.field_label in labels:
                    sec.total += 1
                    sec.points_possible += q.points_possible
                    sec.points_earned += q.points_earned
                    if q.is_correct:
                        sec.correct += 1
            sections[section_name] = sec

    percentage = (total_points / max_points * 100) if max_points > 0 else 0.0

    return GradingReport(
        total_score=total_points,
        max_score=max_points,
        percentage=round(percentage, 2),
        questions=questions,
        sections=sections,
        needs_review=needs_review,
        missing=missing,
    )
