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
  

  
  # Get only Flute-1 and Clarinet_in_Bb PNG files in this subdirectory
  for filename in "${subdir}"*Flute-1.png "${subdir}"*Clarinet_in_Bb-1.png; do
    # Check if files exist (skip if glob didn't match)
    [ -e "$filename" ] || continue
    
    # Extract the base filename without extension
    base_filename=$(basename "$filename" .png)
    output_file="trimmed/${base_filename}.png"
    
    # Skip if output file already exists
    if [ -e "$output_file" ]; then
      echo "Skipping ${filename} (already processed)"
      continue
    fi
    
    echo "Trimming ${filename} to PNG format..."
    magick "${filename}" -trim "$output_file"
  done
done

