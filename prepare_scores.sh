#!/bin/bash
#
# prepare_scores.sh
#
# Finds all *-C.mscz files in the TUNES folder, and for each one:
#   1. Exports the C version as trimmed PNG(s) into trimmed/
#   2. Exports to MusicXML, transposes up a major 2nd (for Bb instruments),
#      then exports the Bb version as trimmed PNG(s) into trimmed/
#   3. Copies any 'link' file from the tune's folder into trimmed/
#
# Prerequisites:
#   - MuseScore 4 installed at the standard macOS location
#   - Python 3 (no external packages needed)
#
# Output naming:
#   TuneName-C-1.png, TuneName-C-2.png, ...   (concert pitch)
#   TuneName-Bb-1.png, TuneName-Bb-1.png, ... (Bb transposition)
#   TuneName-B-1.png, TuneName-B-2.png, ...   (bass clef, down an octave)
#   TuneName_link                              (optional link file)

set -e

# --- Configuration ---
TUNES_FOLDER="/Users/paulleonard/Library/CloudStorage/GoogleDrive-pauljohnleonard@gmail.com/My Drive/MUSIC/BalFolkFrome/TUNES"
MSCORE="/Applications/MuseScore 4.app/Contents/MacOS/mscore"
TRANSPOSE_SCRIPT="$(cd "$(dirname "$0")" && pwd)/src/transpose.py"
STANDARDIZE_SCRIPT="$(cd "$(dirname "$0")" && pwd)/src/standardize_vbox.py"
PYTHON="$(cd "$(dirname "$0")" && pwd)/.venv/bin/python"
TRIMMED_DIR="trimmed"
TEMP_DIR=$(mktemp -d)
TRIM_MARGIN=10  # pixels of margin when trimming PNG export

# Cleanup temp dir on exit
trap "rm -rf '$TEMP_DIR'" EXIT

# --- Sanity checks ---
if [ ! -x "$MSCORE" ]; then
    echo "Error: MuseScore not found at $MSCORE"
    exit 1
fi

if ! "$PYTHON" -c "import zipfile, re" 2>/dev/null; then
    echo "Error: Python 3 is required"
    exit 1
fi

if [ ! -f "$TRANSPOSE_SCRIPT" ]; then
    echo "Error: transpose.py not found at $TRANSPOSE_SCRIPT"
    exit 1
fi

if [ ! -d "$TUNES_FOLDER" ]; then
    echo "Error: TUNES folder not found at $TUNES_FOLDER"
    exit 1
fi

# Create output directory
mkdir -p "$TRIMMED_DIR"

echo "=== Preparing Scores ==="
echo "Source:  $TUNES_FOLDER"
echo "Output:  $TRIMMED_DIR/"
echo

processed=0
skipped=0

# Iterate over each subdirectory in the TUNES folder
for subdir in "$TUNES_FOLDER"/*/; do
    subdir_name=$(basename "$subdir")

    # Find all *-C.mscz files in this subdirectory
    shopt -s nullglob
    c_files=("$subdir"*-C.mscz)
    shopt -u nullglob

    if [ ${#c_files[@]} -eq 0 ]; then
        continue
    fi

    for c_file in "${c_files[@]}"; do
        # Extract tune name: e.g. "Batiska-C.mscz" -> "Batiska"
        base_filename=$(basename "$c_file")
        tune_name="${base_filename%-C.mscz}"

        echo "--- $tune_name ---"

        # Check if C PNG already exists (skip if so)
        c_png_exists=false
        for f in "$TRIMMED_DIR/${tune_name}-C-"*.png; do
            [ -e "$f" ] && c_png_exists=true && break
        done

        if $c_png_exists; then
            echo "  Skipping (already processed)"
            skipped=$((skipped + 1))
            continue
        fi

        # --- Step 1: Standardize VBox and export C version to PNG ---
        echo "  Standardizing title/composer layout..."
        mscz_c="$TEMP_DIR/${tune_name}-C.mscz"
        cp "$c_file" "$mscz_c"
        "$PYTHON" "$STANDARDIZE_SCRIPT" "$mscz_c"

        echo "  Exporting C version to PNG..."
        "$MSCORE" -T "$TRIM_MARGIN" -o "$TRIMMED_DIR/${tune_name}-C.png" "$mscz_c" 2>/dev/null

        # --- Step 2: Transpose to Bb .mscz ---
        echo "  Transposing to Bb..."
        mscz_bb="$TEMP_DIR/${tune_name}-Bb.mscz"
        "$PYTHON" "$TRANSPOSE_SCRIPT" "$mscz_c" "$mscz_bb"

        # --- Step 3: Export Bb version to PNG ---
        echo "  Exporting Bb version to PNG..."
        "$MSCORE" -T "$TRIM_MARGIN" -o "$TRIMMED_DIR/${tune_name}-Bb.png" "$mscz_bb" 2>/dev/null

        # --- Step 4: Transpose to Bass clef .mscz (down one octave) ---
        echo "  Creating bass clef version..."
        mscz_bass="$TEMP_DIR/${tune_name}-B.mscz"
        "$PYTHON" "$TRANSPOSE_SCRIPT" "$mscz_c" "$mscz_bass" --cello

        # --- Step 5: Export Bass clef version to PNG ---
        echo "  Exporting bass clef version to PNG..."
        "$MSCORE" -T "$TRIM_MARGIN" -o "$TRIMMED_DIR/${tune_name}-B.png" "$mscz_bass" 2>/dev/null

        # --- Step 6: Copy link file if present ---
        link_file="$subdir/link"
        if [ -f "$link_file" ]; then
            link_output="$TRIMMED_DIR/${tune_name}_link"
            if [ ! -e "$link_output" ]; then
                echo "  Copying link file..."
                cp "$link_file" "$link_output"
            fi
        fi

        echo "  ✓ Done"
        processed=$((processed + 1))
    done
done

echo
echo "=== Summary ==="
echo "  Processed: $processed tune(s)"
echo "  Skipped:   $skipped tune(s) (already existed)"
echo
