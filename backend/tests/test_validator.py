"""
Unit tests for template_validator.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from app.core.templates.template_loader import load_template
from app.core.templates.template_validator import (
    TemplateValidationError,
    validate_template,
)

TEMPLATE_PATH = Path(__file__).parent.parent / "templates" / "vju_main_template.json"


@pytest.fixture(scope="module")
def template():
    if not TEMPLATE_PATH.exists():
        pytest.skip(f"Template not found: {TEMPLATE_PATH}")
    return load_template(TEMPLATE_PATH)


class TestTemplateValidator:
    def test_valid_template_passes(self, template):
        """Real VJU template should pass validation without errors."""
        warnings = validate_template(template)
        # May produce warnings but should not raise
        assert isinstance(warnings, list)

    def test_no_errors_on_real_template(self, template):
        """validate_template must not raise TemplateValidationError."""
        try:
            validate_template(template)
        except TemplateValidationError as e:
            pytest.fail(f"Unexpected validation error: {e}")

    def test_page_dimensions_present(self, template):
        assert template.page_dimensions[0] > 0
        assert template.page_dimensions[1] > 0

    def test_all_custom_labels_are_valid(self, template):
        """Every label in customLabels must appear in all_labels."""
        all_labels_set = set(template.all_labels)
        for custom_key, labels in template.custom_labels.items():
            for lbl in labels:
                assert lbl in all_labels_set, (
                    f"Custom label '{lbl}' in '{custom_key}' "
                    f"not found in field blocks"
                )

    def test_no_duplicate_labels(self, template):
        labels = template.all_labels
        assert len(labels) == len(set(labels)), "Duplicate labels found"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
