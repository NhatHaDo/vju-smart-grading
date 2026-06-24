"""
template_validator.py
=====================
Validate a parsed VJUTemplate for correctness before running OMR.
"""

from __future__ import annotations

from app.core.templates.template_loader import VJUTemplate


class TemplateValidationError(Exception):
    pass


def validate_template(template: VJUTemplate) -> list[str]:
    """
    Run all validation checks. Returns a list of warning strings.
    Raises TemplateValidationError on fatal issues.
    """
    errors: list[str] = []
    warnings: list[str] = []

    # 1. Page dimensions
    pw, ph = template.page_dimensions
    if pw <= 0 or ph <= 0:
        errors.append(f"Invalid pageDimensions: {template.page_dimensions}")

    # 2. Default bubble dimensions
    bw, bh = template.default_bubble_dimensions
    if bw <= 0 or bh <= 0:
        errors.append(f"Invalid default bubbleDimensions: {template.default_bubble_dimensions}")

    # 3. Field blocks non-empty
    if not template.field_blocks:
        errors.append("No fieldBlocks found in template")

    # 4. No duplicate labels across blocks
    seen_labels: set[str] = set()
    for block in template.field_blocks:
        duplicates = seen_labels.intersection(block.field_labels)
        if duplicates:
            errors.append(
                f"Duplicate field labels {sorted(duplicates)} in block '{block.name}'"
            )
        seen_labels.update(block.field_labels)

    # 5. Each block has at least one field label and one bubble
    for block in template.field_blocks:
        if not block.field_labels:
            errors.append(f"Block '{block.name}' has no field labels")
        if not block.bubbles:
            errors.append(f"Block '{block.name}' has no generated bubbles")

    # 6. Validate customLabels reference known field labels
    for custom_key, custom_labels in template.custom_labels.items():
        missing = [lbl for lbl in custom_labels if lbl not in seen_labels]
        if missing:
            errors.append(
                f"Custom label '{custom_key}' references unknown field labels: {missing}"
            )

    # 7. Bubble gap sanity check
    for block in template.field_blocks:
        bw_b, bh_b = block.bubble_dimensions
        if block.direction == "vertical":
            if block.bubbles_gap < bh_b:
                warnings.append(
                    f"Block '{block.name}': bubblesGap ({block.bubbles_gap}) < "
                    f"bubbleHeight ({bh_b}) — bubbles may overlap vertically"
                )
            if block.labels_gap < bw_b:
                warnings.append(
                    f"Block '{block.name}': labelsGap ({block.labels_gap}) < "
                    f"bubbleWidth ({bw_b}) — columns may overlap"
                )
        else:  # horizontal
            if block.bubbles_gap < bw_b:
                warnings.append(
                    f"Block '{block.name}': bubblesGap ({block.bubbles_gap}) < "
                    f"bubbleWidth ({bw_b}) — bubbles may overlap horizontally"
                )
            if block.labels_gap < bh_b:
                warnings.append(
                    f"Block '{block.name}': labelsGap ({block.labels_gap}) < "
                    f"bubbleHeight ({bh_b}) — rows may overlap"
                )

    if errors:
        raise TemplateValidationError(
            f"Template validation failed with {len(errors)} error(s):\n"
            + "\n".join(f"  • {e}" for e in errors)
        )

    return warnings
