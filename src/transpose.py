#!/usr/bin/env python3
"""
Transpose a MuseScore .mscz file by modifying pitch data directly in the XML.

This preserves ALL MuseScore styling, layout, fonts, and formatting — unlike
a MusicXML round-trip which loses MuseScore-specific properties.

Usage:
    python3 transpose.py input.mscz output.mscz [semitones] [--clef CLEF]
    python3 transpose.py input.mscz output.mscz --cello

Arguments:
    input.mscz   - Source MuseScore file (e.g. C version)
    output.mscz  - Output MuseScore file (transposed)
    semitones    - Number of semitones to transpose (default: 2 for Bb)
                   Positive = up, negative = down (e.g. -12 = down one octave)
    --clef CLEF  - Change clef. Options: G (treble), F (bass), C (alto)
    --cello      - Auto-select octave for cello (A4 max, C2 min), bass clef

Examples:
    # Bb version (up a major 2nd):
    python3 transpose.py score-C.mscz score-Bb.mscz 2

    # Bass clef version (down an octave):
    python3 transpose.py score-C.mscz score-B.mscz -12 --clef F

Pitch encoding in .mscx XML:
    <pitch>  = MIDI pitch number (0-127). Transposed by adding semitones.
    <tpc>    = Tonal Pitch Class on the line of fifths.
               C=14, G=15, D=16, A=17, E=18, B=19, F#=20, ...
               F=13, Bb=12, Eb=11, Ab=10, Db=9, Gb=8, ...
               For octave transposition, tpc stays the same.
               A major 2nd = 2 steps on the line of fifths, so tpc += 2.
    <concertKey> = Key signature (number of sharps/flats).
    Harmony <root>/<bass> = Same tpc system for chord symbols.
"""

import sys
import os
import re
import zipfile
import shutil
import tempfile


def transpose_value(match, semitones):
    """Replace an integer value inside an XML tag, adding semitones."""
    prefix = match.group(1)
    value = int(match.group(2))
    suffix = match.group(3)
    return f"{prefix}{value + semitones}{suffix}"


def get_pitch_range(xml_content):
    """Extract min and max MIDI pitch values from .mscx XML content."""
    pitches = [int(m) for m in re.findall(
        r"<pitch>(-?\d+)</pitch>", xml_content)]
    if not pitches:
        return None, None
    return min(pitches), max(pitches)


def get_pitch_range_from_mscz(mscz_path):
    """Read the main .mscx from a .mscz and return (min_pitch, max_pitch)."""
    with zipfile.ZipFile(mscz_path, "r") as zf:
        # Find the top-level .mscx (not in Excerpts/)
        for name in zf.namelist():
            if name.endswith(".mscx") and "/" not in name:
                content = zf.read(name).decode("utf-8")
                return get_pitch_range(content)
    return None, None


# Cello range limits (MIDI pitch numbers)
CELLO_MAX = 69  # A4 — A above middle C
CELLO_MIN = 36  # C2 — 2 octaves below middle C


def choose_cello_transposition(min_pitch, max_pitch):
    """
    Choose the best octave transposition for cello range.

    Strategy:
        - Try -12 (1 octave down): use if max note fits within cello range
        - Try -24 (2 octaves down): use if min note stays above cello low C
        - If neither fits, use -24 (better too low than unplayably high)

    Returns semitones (int).
    """
    if min_pitch is None or max_pitch is None:
        print("  Warning: No pitches found, defaulting to -12")
        return -12

    # Try 1 octave down
    if max_pitch - 12 <= CELLO_MAX:
        if min_pitch - 12 >= CELLO_MIN:
            print(f"  Pitch range: {min_pitch}-{max_pitch} → "
                  f"1 octave down → {min_pitch-12}-{max_pitch-12}")
            return -12
        else:
            print(f"  Pitch range: {min_pitch}-{max_pitch} → "
                  f"1 octave down fits top but lowest note "
                  f"({min_pitch-12}) below cello C2 ({CELLO_MIN})")
            return -12  # Still best option

    # Try 2 octaves down
    if min_pitch - 24 >= CELLO_MIN:
        print(f"  Pitch range: {min_pitch}-{max_pitch} → "
              f"2 octaves down → {min_pitch-24}-{max_pitch-24}")
        return -24

    # Neither fits perfectly — 2 octaves is less bad
    print(f"  Pitch range: {min_pitch}-{max_pitch} → "
          f"2 octaves down (some notes out of range: "
          f"{min_pitch-24}-{max_pitch-24})")
    return -24


def transpose_mscx_content(xml_content, semitones, tpc_delta=None):
    """
    Transpose all pitch data in .mscx XML content.

    Args:
        xml_content: The .mscx XML as a string
        semitones: Number of semitones to shift MIDI pitch values
        tpc_delta: Number of steps to shift on the line of fifths for tpc,
                   concertKey, and harmony root/bass. If None, defaults to
                   semitones (correct for M2 transposition). Set to 0 for
                   pure octave transposition.
    """
    if tpc_delta is None:
        tpc_delta = semitones

    # Transpose MIDI pitch values
    xml_content = re.sub(
        r"(<pitch>)(-?\d+)(</pitch>)",
        lambda m: transpose_value(m, semitones),
        xml_content,
    )

    # Transpose tonal pitch class values
    xml_content = re.sub(
        r"(<tpc>)(-?\d+)(</tpc>)",
        lambda m: transpose_value(m, tpc_delta),
        xml_content,
    )

    # Transpose tpc2 if present (transposing instruments)
    xml_content = re.sub(
        r"(<tpc2>)(-?\d+)(</tpc2>)",
        lambda m: transpose_value(m, tpc_delta),
        xml_content,
    )

    # Transpose key signatures
    xml_content = re.sub(
        r"(<concertKey>)(-?\d+)(</concertKey>)",
        lambda m: transpose_value(m, tpc_delta),
        xml_content,
    )

    # Transpose harmony root (chord symbols)
    xml_content = re.sub(
        r"(<root>)(-?\d+)(</root>)",
        lambda m: transpose_value(m, tpc_delta),
        xml_content,
    )

    # Transpose harmony bass note
    xml_content = re.sub(
        r"(<bass>)(-?\d+)(</bass>)",
        lambda m: transpose_value(m, tpc_delta),
        xml_content,
    )

    return xml_content


def change_clef_in_mscx(xml_content, clef):
    """
    Change the clef in a .mscx XML string.

    Args:
        xml_content: The .mscx XML as a string
        clef: Target clef type - "G" (treble), "F" (bass), "C" (alto)

    Modifies:
        - <defaultClef> in Staff (adds if missing)
        - <clef> in Instrument (adds if missing)
        - Existing <Clef> elements in the score (concertClefType, transposingClefType)
    """
    # Update or add <defaultClef> in <Staff> blocks within <Part>
    def fix_staff_clef(match):
        staff = match.group(0)
        if "<defaultClef>" in staff:
            staff = re.sub(
                r"<defaultClef>[^<]*</defaultClef>",
                f"<defaultClef>{clef}</defaultClef>",
                staff,
            )
        else:
            # Add after </StaffType>
            staff = re.sub(
                r"(</StaffType>)",
                f"\\1\n        <defaultClef>{clef}</defaultClef>",
                staff,
            )
        return staff

    # Only modify <Staff> elements inside <Part> (not the score <Staff> elements)
    xml_content = re.sub(
        r"(<Part[^>]*>.*?</Part>)",
        lambda m: re.sub(
            r"<Staff[^>]*>.*?</Staff>",
            fix_staff_clef,
            m.group(0),
            flags=re.DOTALL,
        ),
        xml_content,
        flags=re.DOTALL,
    )

    # Update or add <clef> in <Instrument> blocks
    def fix_instrument_clef(match):
        inst = match.group(0)
        if re.search(r"<clef>[^<]*</clef>", inst):
            inst = re.sub(
                r"<clef>[^<]*</clef>",
                f"<clef>{clef}</clef>",
                inst,
            )
        else:
            # Add before </Instrument>
            inst = re.sub(
                r"(</Instrument>)",
                f"        <clef>{clef}</clef>\n        \\1",
                inst,
            )
        return inst

    xml_content = re.sub(
        r"<Instrument[^>]*>.*?</Instrument>",
        fix_instrument_clef,
        xml_content,
        flags=re.DOTALL,
    )

    # Update any existing <Clef> elements in the score body
    xml_content = re.sub(
        r"<concertClefType>[^<]*</concertClefType>",
        f"<concertClefType>{clef}</concertClefType>",
        xml_content,
    )
    xml_content = re.sub(
        r"<transposingClefType>[^<]*</transposingClefType>",
        f"<transposingClefType>{clef}</transposingClefType>",
        xml_content,
    )

    return xml_content


def transpose_mscz(input_path, output_path, semitones=2, tpc_delta=None,
                   clef=None):
    """Transpose a .mscz file by modifying pitch data in the contained XML.

    Args:
        input_path: Path to source .mscz file
        output_path: Path to write transposed .mscz file
        semitones: MIDI pitch shift (e.g. 2 for M2 up, -12 for octave down)
        tpc_delta: Line-of-fifths shift (None = same as semitones, 0 for octave)
        clef: Optional clef change ("G", "F", or "C")
    """
    if not os.path.exists(input_path):
        print(f"Error: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading: {input_path}")

    # Create a temporary directory to work in
    with tempfile.TemporaryDirectory() as tmp_dir:
        # Extract the .mscz (zip) file
        extract_dir = os.path.join(tmp_dir, "extracted")
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(extract_dir)

        # Find and transpose all .mscx files (main score + excerpts)
        mscx_count = 0
        for root, dirs, files in os.walk(extract_dir):
            for fname in files:
                if fname.endswith(".mscx"):
                    fpath = os.path.join(root, fname)
                    print(f"  Transposing: {fname}")

                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()

                    content = transpose_mscx_content(content, semitones,
                                                     tpc_delta)

                    if clef:
                        content = change_clef_in_mscx(content, clef)

                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(content)

                    mscx_count += 1

        if mscx_count == 0:
            print("Warning: No .mscx files found in the archive!", file=sys.stderr)

        # Re-pack as .mscz (zip)
        print(f"Writing: {output_path}")
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(extract_dir):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, extract_dir)
                    zf.write(fpath, arcname)

    print(
        f"Done. Transposed {mscx_count} .mscx file(s) by {semitones} semitones"
        + (f", clef → {clef}" if clef else "")
        + "."
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Transpose a MuseScore .mscz file"
    )
    parser.add_argument("input", help="Input .mscz file")
    parser.add_argument("output", help="Output .mscz file")
    parser.add_argument(
        "semitones",
        nargs="?",
        type=int,
        default=2,
        help="Semitones to transpose (default: 2). Use -12 for octave down.",
    )
    parser.add_argument(
        "--clef",
        choices=["G", "F", "C"],
        help="Change clef: G (treble), F (bass), C (alto)",
    )
    parser.add_argument(
        "--tpc-delta",
        type=int,
        default=None,
        help="TPC delta (default: same as semitones, use 0 for octave)",
    )
    parser.add_argument(
        "--cello",
        action="store_true",
        help="Auto-select octave transposition for cello range "
             "(A4 max, C2 min). Implies --clef F --tpc-delta 0.",
    )

    args = parser.parse_args()

    if args.cello:
        # Analyze pitch range and choose -12 or -24
        min_p, max_p = get_pitch_range_from_mscz(args.input)
        semitones = choose_cello_transposition(min_p, max_p)
        transpose_mscz(
            args.input,
            args.output,
            semitones=semitones,
            tpc_delta=0,
            clef="F",
        )
    else:
        transpose_mscz(
            args.input,
            args.output,
            semitones=args.semitones,
            tpc_delta=args.tpc_delta,
            clef=args.clef,
        )
