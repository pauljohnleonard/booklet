#!/bin/bash
# This script converts a MuseScore file to PNG format using the MuseScore application.
# Ensure the MuseScore application path is correct for your system.

set -x

folder="/Users/paulleonard/Library/CloudStorage/GoogleDrive-pauljohnleonard@gmail.com/My Drive/MUSIC/BalFolkFrome/TUNES/"

# Create the main trimmed directory
mkdir -p trimmed

# Find all subdirectories in the main folder
for subdir in "${folder}"*/; do
  subdir_name=$(basename "${subdir}")
  echo "Processing subdirectory: ${subdir_name}"
  

  
  # Get all Flute PNG files in this subdirectory
  for filename in "${subdir}"*Flute*.png; do
    # Check if files exist
    [ -e "$filename" ] || continue
    
    echo "Trimming ${filename} to PNG format..."
    # Extract the base filename without extension
    base_filename=$(basename "$filename" .png)

    magick "${filename}" -trim "trimmed/${base_filename}.png"
  done
done
