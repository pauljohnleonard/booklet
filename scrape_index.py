#!/usr/bin/env python3
"""
Scrape the 'A World of Music' circle dance book contents from judyking.co.uk
and build a CSV index mapping each dance to the book(s) it appears in.

Output: dance_book_index.csv
"""

import csv
import html as html_mod
import os
import re
import urllib.request

TUNES_DIR = os.path.expanduser(
    "~/Google Drive/My Drive/MUSIC/CircleDance/TUNES")


def fetch_volume(vol_num):
    url = f"https://www.judyking.co.uk/shop/musicbooks/worldofmusic{vol_num}.htm"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_tunes_from_section(section_html):
    """Extract tune names from a section. Tunes are in <div class="col"> separated by <br>."""
    tunes = []
    for col_match in re.finditer(r'<div class="col">(.*?)</div>', section_html, re.DOTALL):
        col_content = col_match.group(1)
        items = re.split(r'<br\s*/?>', col_content)
        for item in items:
            text = re.sub(r'<[^>]+>', '', item)
            text = html_mod.unescape(text).strip()
            if text:
                tunes.append(text)
    return tunes


def parse_tunes(page_html):
    """Parse tune names from the HTML. Returns (main_tunes, appendix_tunes)."""
    contents_match = re.search(
        r'<h2>Contents</h2>(.*?)(?:<div class="col-lg-4|$)', page_html, re.DOTALL)
    if not contents_match:
        return [], []

    contents_html = contents_match.group(1)

    appendix_match = re.search(
        r'<h4[^>]*>(.*?Appendix.*?)</h4>(.*)', contents_html, re.DOTALL | re.IGNORECASE)

    if appendix_match:
        main_html = contents_html[:appendix_match.start()]
        appendix_html = appendix_match.group(2)
        return extract_tunes_from_section(main_html), extract_tunes_from_section(appendix_html)
    else:
        return extract_tunes_from_section(contents_html), []


def fetch_nickomo():
    url = "https://nickomoandrasullah.com/product/music-for-circle-dance-edition-2014/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_nickomo(page_html):
    """Parse tune names from the Nickomo book page. Tunes are <br>-separated in <td> cells."""
    tunes = []
    # Find the table after "Songs include:"
    m = re.search(
        r'Songs include:.*?<table[^>]*>(.*?)</table>', page_html, re.DOTALL)
    if not m:
        return tunes
    table_html = m.group(1)
    # Extract text from each <td>, split on <br>
    for td in re.finditer(r'<td[^>]*>(.*?)</td>', table_html, re.DOTALL):
        items = re.split(r'<br\s*/?>', td.group(1))
        for item in items:
            text = re.sub(r'<[^>]+>', '', item)
            text = html_mod.unescape(text).strip()
            if text:
                tunes.append(text)

    # Fix known line-break splits in the source HTML
    fixes = {
        ("Ajde Red Se Redat", "Male"): "Ajde Red Se Redat Male",
    }
    for (first, second), merged in fixes.items():
        while first in tunes:
            idx = tunes.index(first)
            if idx + 1 < len(tunes) and tunes[idx + 1] == second:
                tunes[idx:idx + 2] = [merged]
            else:
                break

    return tunes


def clean_tune_name(name):
    return re.sub(r'\s+', ' ', name).strip()


# Known fixes: entries that need splitting into separate tunes
SPLIT_FIXES = {
    "Les Noto - Ajde Red Se Redat Male": ["Les Noto", "Ajde Red Se Redat Male"],
    "Makedonsko \u2013 \u2018Ja izlezi libe licno\u2019": ["Makedonsko Devojce", "Ja izlezi libe licno"],
    'Pravo Horo (Bul.) ("Hodilla Mi E Bojana")': ["Pravo Horo", "Hodilla Mi E Bojana"],
    'Pravo Oro (Mac.). ("Zumbaj Zumba Ba")': ["Pravo Oro", "Zumbaj Zumba Ba"],
    'Pravo Rhodopsko Horo (Bul.) ("Kitko Zelena")': ["Pravo Rhodopsko Horo", "Kitko Zelena"],
    "Vranjanke \u2013 Sano Duso": ["Vranjanke", "Sano Duso"],
    'Zeybekkio (Gr.) ("Aide Mandalyo")': ["Zeybekkio", "Aide Mandalyo"],
    'Samokovsko Horo (Bul.) "Sareni Carapi"': ["Samokovsko Horo", "Sareni Carapi"],
    'Galician Processional ("Non Sofre Santa Maria")': ["Galician Processional", "Non Sofre Santa Maria"],
    'Garland Of Stars "Flatbush Waltz" By A. Statman': ["Garland Of Stars", "Flatbush Waltz"],
    'Trata "To Mikro Mou"': ["Trata", "To Mikro Mou"],
    "Trata \u2013 \u2018To Mikro Moj\u2019": ["Trata", "To Mikro Mou"],
}


def add_tunes(dance_index, tunes, book_name):
    for tune in tunes:
        name = clean_tune_name(tune)
        if name in SPLIT_FIXES:
            for part in SPLIT_FIXES[name]:
                dance_index.setdefault(part, set()).add(book_name)
        elif name:
            dance_index.setdefault(name, set()).add(book_name)


def main():
    dance_index = {}  # dance_name -> set of books

    # A World of Music volumes 1-5
    for vol in range(1, 6):
        print(f"Fetching Mandy {vol}...")
        page_html = fetch_volume(vol)
        main_tunes, appendix_tunes = parse_tunes(page_html)

        book_name = f"Mandy {vol}"
        print(
            f"  Found {len(main_tunes)} main tunes, {len(appendix_tunes)} appendix tunes")
        add_tunes(dance_index, main_tunes, book_name)
        add_tunes(dance_index, appendix_tunes, book_name + " (Appendix)")

    # Nickomo - Music for Circle Dance (2014)
    print("Fetching Nickomo...")
    nickomo_html = fetch_nickomo()
    nickomo_tunes = parse_nickomo(nickomo_html)
    print(f"  Found {len(nickomo_tunes)} tunes")
    add_tunes(dance_index, nickomo_tunes, "Nickomo")

    # Google Drive tune folders
    if os.path.isdir(TUNES_DIR):
        print(f"Scanning GDRIVE ({TUNES_DIR})...")
        gdrive_tunes = sorted(
            entry for entry in os.listdir(TUNES_DIR)
            if os.path.isdir(os.path.join(TUNES_DIR, entry))
            and not entry.startswith('.')
        )
        print(f"  Found {len(gdrive_tunes)} tune folders")
        add_tunes(dance_index, gdrive_tunes, "GDRIVE")
    else:
        print(f"  GDRIVE folder not found: {TUNES_DIR} (skipping)")

    # Write CSV sorted by dance name
    output_file = "dance_book_index.csv"
    with open(output_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Dance", "Book(s)"])
        for dance in sorted(dance_index.keys(), key=str.lower):
            books = "; ".join(sorted(dance_index[dance]))
            writer.writerow([dance, books])

    print(f"\nWrote {len(dance_index)} dances to {output_file}")


if __name__ == "__main__":
    main()
