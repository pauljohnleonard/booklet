#!/usr/bin/env python3
"""
Standardize title/composer frame (VBox) in MuseScore .mscz files.

Normalizes the VBox across all .mscx files (main score + excerpts) so that
title and composer positioning is consistent. This removes random offsets
that accumulate from manual editing in MuseScore.

Usage:
    python3 standardize_vbox.py input.mscz [output.mscz]

If output is omitted, the input file is modified in-place.

What it does:
    - Sets VBox height to a standard value (default: 5)
    - Enables boxAutoSize=0 for consistent sizing
    - Removes offset elements from title and composer Text blocks
    - Removes positionLinkedToMaster from Text blocks (so excerpts match)
    - Standardizes title and composer fonts (face, size, style)
    - Standardizes frame text (sub-tune headers) to consistent font/size
    - Preserves all other VBox content (instrument_excerpt text, eids, etc.)
"""

import sys
import os
import re
import zipfile
import tempfile

# Standard VBox height (in spatium units)
STANDARD_HEIGHT = 5

# Standard font settings for title and composer
STANDARD_FONTS = {
    "titleFontFace": "MuseJazz Text",
    "titleFontSize": "22",
    "titleLineSpacing": "1",
    "titleFontStyle": "0",
    "titleFontSpatiumDependent": "0",
    "composerFontFace": "MuseJazz Text",
    "composerFontSize": "12",
    "composerLineSpacing": "1",
    "composerFontStyle": "0",
    "composerFontSpatiumDependent": "0",
    "frameFontFace": "MuseJazz Text",
    "frameFontSize": "16",
    "frameLineSpacing": "1",
    "frameFontStyle": "0",
    "frameFontSpatiumDependent": "0",
}

# Standard height for sub-tune VBoxes (smaller than main title VBox)
SUBTUNE_VBOX_HEIGHT = 3


def standardize_vbox_in_mscx(xml_content):
    """
    Standardize all VBox elements in a .mscx XML string.

    - Set height to STANDARD_HEIGHT (first VBox) or SUBTUNE_VBOX_HEIGHT (subsequent)
    - Ensure boxAutoSize=0
    - Remove offset from title, composer, and frame Text blocks
    - Remove positionLinkedToMaster from Text blocks
    - Clean up inline font overrides in frame text
    """

    vbox_counter = [0]  # mutable counter for closure

    def fix_vbox(vbox_match):
        vbox = vbox_match.group(0)
        is_first = vbox_counter[0] == 0
        vbox_counter[0] += 1

        # Use appropriate height based on whether this is the main title or a sub-tune
        height = STANDARD_HEIGHT if is_first else SUBTUNE_VBOX_HEIGHT

        # Standardize height
        vbox = re.sub(
            r"<height>[^<]*</height>",
            f"<height>{height}</height>",
            vbox,
        )

        # Ensure boxAutoSize is 0 (add if missing)
        if "<boxAutoSize>" in vbox:
            vbox = re.sub(
                r"<boxAutoSize>[^<]*</boxAutoSize>",
                "<boxAutoSize>0</boxAutoSize>",
                vbox,
            )
        else:
            # Insert after <height>...</height>
            vbox = re.sub(
                r"(<height>[^<]*</height>)",
                r"\1\n        <boxAutoSize>0</boxAutoSize>",
                vbox,
            )

        # Remove offset elements from title, composer, and frame Text blocks
        # We need to handle each Text block individually
        def fix_text_block(text_match):
            text = text_match.group(0)
            style_match = re.search(
                r"<style>(title|composer|frame)</style>", text)
            if style_match:
                # Remove offset lines (with any indentation)
                text = re.sub(r"\s*<offset [^/]*/?>\s*\n?", "\n", text)
                # Remove positionLinkedToMaster lines
                text = re.sub(
                    r"\s*<positionLinkedToMaster>[^<]*</positionLinkedToMaster>\s*\n?",
                    "\n",
                    text,
                )

                if style_match.group(1) == "frame":
                    # Remove <size> element (font size set via style instead)
                    text = re.sub(r"\s*<size>[^<]*</size>\s*\n?", "\n", text)
                    # Remove inline font size attributes from <text> content
                    text = re.sub(r'<font size="[^"]*"/>', "", text)

                # Clean up any resulting blank lines
                text = re.sub(r"\n\s*\n", "\n", text)
            return text

        vbox = re.sub(
            r"<Text>.*?</Text>", fix_text_block, vbox, flags=re.DOTALL
        )

        return vbox

    return re.sub(r"<VBox>.*?</VBox>", fix_vbox, xml_content, flags=re.DOTALL)


def standardize_fonts_in_style(style_content):
    """
    Standardize title and composer font settings in a style string.

    Works on both .mss files and inline <Style> blocks in .mscx files.
    Updates existing font properties to the standard values.
    """
    for prop, value in STANDARD_FONTS.items():
        pattern = rf"(<{prop}>)[^<]*(</{prop}>)"
        if re.search(pattern, style_content):
            style_content = re.sub(pattern, rf"\g<1>{value}\2", style_content)
    return style_content


def standardize_mscz(input_path, output_path=None):
    """Standardize VBox in a .mscz file."""
    if output_path is None:
        output_path = input_path

    if not os.path.exists(input_path):
        print(f"Error: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading: {input_path}")

    with tempfile.TemporaryDirectory() as tmp_dir:
        extract_dir = os.path.join(tmp_dir, "extracted")
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(extract_dir)

        mscx_count = 0
        mss_count = 0
        for root, dirs, files in os.walk(extract_dir):
            for fname in files:
                fpath = os.path.join(root, fname)

                if fname.endswith(".mscx"):
                    print(f"  Standardizing VBox: {fname}")

                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()

                    content = standardize_vbox_in_mscx(content)
                    # Also standardize any inline <Style> blocks in excerpts
                    content = standardize_fonts_in_style(content)

                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(content)

                    mscx_count += 1

                elif fname.endswith(".mss"):
                    print(f"  Standardizing fonts: {fname}")

                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()

                    content = standardize_fonts_in_style(content)

                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(content)

                    mss_count += 1

        if mscx_count == 0:
            print(
                "Warning: No .mscx files found in the archive!",
                file=sys.stderr,
            )

        print(f"Writing: {output_path}")
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(extract_dir):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, extract_dir)
                    zf.write(fpath, arcname)

    print(f"Done. Standardized {mscx_count} .mscx + {mss_count} .mss file(s).")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None

    standardize_mscz(input_file, output_file)
