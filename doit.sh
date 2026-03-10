#!/bin/bash

GDRIVE_BOOKLETS="/Users/paulleonard/Google Drive/My Drive/MUSIC/BalFolkFrome/Booklets"

echo "=== Booklet Generation ==="
echo
echo "  1) Rebuild everything (full regeneration)"
echo "  2) Add new tunes to end of booklet"
echo
read -p "Choose [1/2]: " choice

case $choice in
    1)
        echo
        echo "--- Full rebuild ---"

        # Clear all generated artifacts
        echo "Clearing trimmed/ and booklets/..."
        rm -rf trimmed/*.png booklets/*.pdf
        rm -f baseline_*.txt

        # Prepare all scores from MuseScore files
        echo "Preparing scores..."
        ./prepare_scores.sh

        # Create baseline from what we just generated
        echo "Creating baseline..."
        ./create_baseline.sh

        # Generate booklets
        echo "Generating booklets..."
        node src/main.js

        # Copy to Google Drive
        echo "Copying to Google Drive..."
        cp booklets/*.pdf "$GDRIVE_BOOKLETS/"

        echo
        echo "✓ Full rebuild complete"
        ;;

    2)
        echo
        echo "--- Adding new tunes ---"

        # Remove artifacts for tunes NOT in the baseline (i.e. new tunes)
        # so prepare_scores.sh will regenerate them fresh
        if [ ! -f "baseline_c.txt" ]; then
            echo "Error: No baseline files found. Run option 1 first."
            exit 1
        fi

        echo "Removing new tune artifacts..."
        for png in trimmed/*-C-*.png; do
            [ -e "$png" ] || continue
            fname=$(basename "$png")
            if ! grep -qF "$fname" baseline_c.txt; then
                tune_name="${fname%-C-*}"
                echo "  Removing: $tune_name"
                rm -f trimmed/"${tune_name}"-C-*.png
                rm -f trimmed/"${tune_name}"-Bb-*.png
                rm -f trimmed/"${tune_name}"-B-*.png
                rm -f trimmed/"${tune_name}"_link
            fi
        done

        # Prepare scores (will only process new/missing tunes)
        echo "Preparing new scores..."
        ./prepare_scores.sh

        # Generate booklets (baseline files ensure appendix mode)
        echo "Generating booklets..."
        node src/main.js

        # Copy to Google Drive
        echo "Copying to Google Drive..."
        cp booklets/*.pdf "$GDRIVE_BOOKLETS/"

        echo
        echo "✓ New tunes added"
        ;;

    *)
        echo "Invalid choice. Please run again and choose 1 or 2."
        exit 1
        ;;
esac

echo "=== Done ==="
