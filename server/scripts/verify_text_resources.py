"""Validate shipped catalogs without loading models, secrets or runtime memory."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.text_resources import validate_text_resources


if __name__ == "__main__":
    print(validate_text_resources())
