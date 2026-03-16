import muhammara from "muhammara";
import fs from "fs";
import path from "path";
import imageSize from "image-size"; // npm install image-size
import { PDFDocument } from "pdf-lib"; // npm install pdf-lib
import QRCode from "qrcode"; // npm install qrcode
import os from "os";

// Ensure output folder exists early
if (!fs.existsSync("booklets")) {
  fs.mkdirSync("booklets", { recursive: true });
}

const instruments = [
  { file: "C", title: "C" },
  { file: "Bb", title: "Bb" },
  { file: "B", title: "Bass" },
];

// Escape instrument for safe use in RegExp
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// QR code configuration
const QR_CODE_SIZE = 35; // PDF points (~12mm) — easily scannable on laser printers
const QR_PIXELS = 200; // Pixel resolution of generated QR PNG
const QR_CODE_GAP = 10; // Horizontal gap between side-by-side QR codes
const QR_TOP_MARGIN = 5; // Vertical space above QR row

// Per-tune dance-type label (small tag above first page of each tune)
const DANCE_LABEL_SIZE = 8; // Font size for dance-type label beside title

/**
 * Load dance types from dance_types.json.
 * Returns the "dances" object: { danceType: [tuneName, ...], ... }
 */
function loadDanceTypes() {
  const danceTypesPath = "dance_types.json";
  if (!fs.existsSync(danceTypesPath)) {
    console.warn("dance_types.json not found — dance-type index will be empty");
    return {};
  }
  const data = JSON.parse(fs.readFileSync(danceTypesPath, "utf8"));
  return data.dances || {};
}

/**
 * Build a reverse map: tuneName (lowercase, trimmed) → [danceType, ...].
 * A tune may appear in multiple dance types.
 */
function buildTuneToDanceTypesMap(danceTypes) {
  const map = new Map();
  for (const [danceType, tunes] of Object.entries(danceTypes)) {
    if (danceType === "Unclassified") continue;
    for (const tune of tunes) {
      const key = tune.trim().toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(danceType);
    }
  }
  return map;
}

/**
 * Extract the human-readable tune base name from a PNG filename.
 *   "Batiska-C-1.png"  →  "Batiska"
 */
function tuneBaseNameFromFilename(filename, instrumentFile) {
  return filename
    .replace(/\.png$/i, "")
    .replace(new RegExp(`-${escapeRegExp(instrumentFile)}-\\d+$`, "i"), "")
    .trim();
}

// Group images into the fewest page-sets using a hybrid strategy:
// - Best-Fit Decreasing (fast heuristic)
// - Exact per-page 0/1 knapsack (pseudo-polynomial) to tightly fill each page
// Returns the better result (fewest pages; tie-break by least slack).
function groupImagesIntoPages(images, contentHeight, scale, imageGap) {
  // Prepare items with scaled height + link spacing
  const items = images.map((img, idx) => ({
    ...img,
    _idx: idx,
    scaledHeight: img.height * scale + (img.linkSpacing || 0),
  }));

  // Helper: convert packed pages (arrays of items with helpers) to original shape
  const stripHelpers = (pages) =>
    pages.map((p) => p.map(({ scaledHeight, _idx, ...rest }) => rest));

  // Heuristic 1: Best-Fit Decreasing
  function packWithBFD(itemsList, capacity, gap) {
    const sorted = itemsList
      .slice()
      .sort((a, b) => b.scaledHeight - a.scaledHeight);
    const pages = []; // each: { items: [], used: number }
    for (const it of sorted) {
      let bestIdx = -1;
      let bestResidual = Infinity;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const needed = (page.used > 0 ? gap : 0) + it.scaledHeight;
        if (page.used + needed <= capacity) {
          const residual = capacity - (page.used + needed);
          if (residual < bestResidual) {
            bestResidual = residual;
            bestIdx = i;
          }
        }
      }
      if (bestIdx === -1) {
        pages.push({ items: [it], used: it.scaledHeight });
      } else {
        const page = pages[bestIdx];
        page.items.push(it);
        page.used += (page.used > 0 ? gap : 0) + it.scaledHeight;
      }
    }
    return pages.map((p) => p.items);
  }

  // Heuristic 2: Per-page 0/1 knapsack (exact for a given page)
  function packWithKnapsack(itemsList, capacity, gap) {
    const pages = [];

    // Oversized items (higher than the available vertical space) get their own page
    const oversized = itemsList.filter((it) => it.scaledHeight > capacity);
    const rest = itemsList.filter((it) => it.scaledHeight <= capacity);
    for (const it of oversized) {
      pages.push([it]);
    }

    // Knapsack trick:
    //   weight(item) = h_i + gap
    //   capacity'    = capacity + gap
    // So any subset with sum(w_i) <= capacity' implies sum(h_i) + (k-1)*gap <= capacity.
    const capW = Math.floor(capacity + gap); // floor for safety
    while (rest.length > 0) {
      const n = rest.length;
      const weights = rest.map((it) => Math.ceil(it.scaledHeight + gap)); // ceil for safety
      const values = rest.map((it) => Math.floor(it.scaledHeight)); // maximize used height

      // dpVal[w] = best value at weight <= w; dpSet[w] = indices chosen to reach dpVal[w]
      const dpVal = new Array(capW + 1).fill(-1);
      const dpSet = new Array(capW + 1).fill(null);
      dpVal[0] = 0;
      dpSet[0] = [];

      for (let i = 0; i < n; i++) {
        const wi = weights[i];
        const vi = values[i];
        for (let w = capW; w >= wi; w--) {
          if (dpVal[w - wi] !== -1) {
            const cand = dpVal[w - wi] + vi;
            if (cand > dpVal[w]) {
              dpVal[w] = cand;
              dpSet[w] = dpSet[w - wi].concat(i);
            } else if (cand === dpVal[w]) {
              const candSet = dpSet[w - wi].concat(i);
              if (!dpSet[w] || candSet.length > dpSet[w].length) {
                dpSet[w] = candSet;
              }
            }
          }
        }
      }

      // Pick the best filled weight
      let bestW = 0;
      let bestVal = -1;
      for (let w = 0; w <= capW; w++) {
        if (dpVal[w] > bestVal) {
          bestVal = dpVal[w];
          bestW = w;
        }
      }

      let chosenIdxs = dpSet[bestW] || [];
      if (chosenIdxs.length === 0) {
        // Fallback: choose the tallest remaining item to ensure progress
        let tallest = 0;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i].scaledHeight > rest[tallest].scaledHeight) tallest = i;
        }
        chosenIdxs = [tallest];
      }

      const chosenSet = new Set(chosenIdxs);
      const pageItems = chosenIdxs.map((i) => rest[i]);

      // Optional: sort items on the page by height (tallest first) for nicer layout
      pageItems.sort((a, b) => b.scaledHeight - a.scaledHeight);
      pages.push(pageItems);

      // Remove chosen from rest
      const newRest = [];
      for (let i = 0; i < rest.length; i++) {
        if (!chosenSet.has(i)) newRest.push(rest[i]);
      }
      rest.length = 0;
      Array.prototype.push.apply(rest, newRest);
    }

    return pages;
  }

  // Evaluate solutions and pick the best
  const pagesBFD = packWithBFD(items, contentHeight, imageGap);
  const pagesDP = packWithKnapsack(items, contentHeight, imageGap);

  function score(pages) {
    const slack = pages.reduce((acc, page) => {
      const used = page.reduce(
        (u, it, idx) => u + it.scaledHeight + (idx > 0 ? imageGap : 0),
        0,
      );
      return acc + Math.max(0, contentHeight - used);
    }, 0);
    return { count: pages.length, slack, pages };
  }

  const sB = score(pagesBFD);
  const sD = score(pagesDP);
  const best =
    sD.count < sB.count
      ? sD
      : sD.count > sB.count
        ? sB
        : sD.slack <= sB.slack
          ? sD
          : sB;

  return stripHelpers(best.pages);
}

/**
 * Combines PNG files from the trimmed folder into a single optimized PDF document
 */
async function combinePDFs(instrument) {
  const trimmedDir = "trimmed";

  // Check if directory exists
  if (!fs.existsSync(trimmedDir)) {
    console.error("Error: 'trimmed' directory not found!");
    return;
  }

  // Get all PNG files from the trimmed directory
  // Use regex to match -C-N.png or -Bb-N.png pattern at end of filename
  const instrumentPattern = new RegExp(
    `-${escapeRegExp(instrument.file)}-\\d+\\.png$`,
    "i",
  );
  const imageFiles = fs
    .readdirSync(trimmedDir)
    .filter((file) => instrumentPattern.test(file))
    .map((file) => path.join(trimmedDir, file));

  if (imageFiles.length === 0) {
    console.error("No PNG files found in the 'trimmed' directory!");
    return;
  }

  // Analyze each PNG to get image information (no canvas)
  const imageInfo = imageFiles.map((filePath) => {
    try {
      const buffer = fs.readFileSync(filePath);
      const { width, height } = imageSize(buffer);
      return {
        path: filePath,
        filename: path.basename(filePath),
        width,
        height,
      };
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
      return null;
    }
  });

  // Filter out any nulls from failed analyses
  const validImages = imageInfo.filter((info) => info !== null);

  // Previously this sorted by filename; we now group later to minimize pages
  if (validImages.length === 0) {
    console.error("No valid PNG files to render.");
    return;
  }

  // Check for baseline files to determine if we need to create appendix
  const baselineFile = `baseline_${instrument.file.toLowerCase()}.txt`;
  let originalImages = validImages;
  let appendixImages = [];
  let hasAppendix = false;

  if (fs.existsSync(baselineFile)) {
    console.log(`Found baseline file: ${baselineFile}`);

    // Read baseline file to get original image list
    const baselineContent = fs.readFileSync(baselineFile, "utf8");
    const baselineImagePaths = baselineContent
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.trim());

    // Create a set of baseline filenames for quick lookup
    const baselineFilenames = new Set(
      baselineImagePaths.map((filepath) => path.basename(filepath)),
    );

    // Separate original and new images
    originalImages = validImages.filter((img) =>
      baselineFilenames.has(img.filename),
    );

    appendixImages = validImages.filter(
      (img) => !baselineFilenames.has(img.filename),
    );

    hasAppendix = appendixImages.length > 0;

    console.log(`Original images: ${originalImages.length}`);
    console.log(`New images for appendix: ${appendixImages.length}`);

    if (hasAppendix) {
      console.log("New images found:");
      appendixImages.forEach((img) => console.log(`  - ${img.filename}`));
    }
  } else {
    console.log("No baseline file found - generating complete booklet");
  }

  // Create temp directory for QR code PNGs
  const qrTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "booklet-qr-"));
  const qrCodeMap = new Map(); // tuneBaseName -> [{url, filepath, label}]

  // Create a new PDF writer
  const outputPath = `booklets/${instrument.file}.pdf`;

  // Make sure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create PDF writer
  const pdfWriter = muhammara.createWriter(outputPath);

  // Track the current page number in the combined PDF
  let pageIndex = 0;
  // Image page number (excludes index pages)
  let imagePageNumber = 0;

  // Collect index entries while placing images
  const indexEntries = [];

  // Try to load a font so we can write text (page numbers and index)
  const fontCandidates = [
    path.join(process.cwd(), "fonts", "Roboto-Regular.ttf"),
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ];
  let font = null;
  for (const pth of fontCandidates) {
    try {
      if (fs.existsSync(pth)) {
        font = pdfWriter.getFontForFile(pth);
        break;
      }
    } catch (_) {}
  }
  if (!font) {
    console.warn(
      "Warning: No TTF font found. Page numbers and index will be skipped.",
    );
  }

  // Define margins in points (72 points = 1 inch)
  const margin = {
    top: 36,
    bottom: 30,
    left: 40,
    right: 40,
  };

  // A4 page size in points
  const pageWidth = 595.28;
  const pageHeight = 841.89;

  // Content area
  const contentWidth = pageWidth - margin.left - margin.right;
  const contentHeight = pageHeight - margin.top - margin.bottom;

  // Helper to draw right-justified page number at the bottom
  function drawPageNumber(ctx, number) {
    if (!font) return;
    const text = String(number);
    const size = 10;
    let textWidth = 0;
    try {
      textWidth = font.calculateTextDimensions(text, size).width || 0;
    } catch (_) {}
    const x = pageWidth - margin.right - textWidth; // right-justify at right margin
    const y = Math.max(12, margin.bottom / 2);
    ctx.writeText(text, x, y, { font, size });
  }

  // Helper to draw date in the bottom left corner
  function drawDate(ctx) {
    if (!font) return;
    const now = new Date();
    const dateText = now.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const size = 10;
    const x = margin.left;
    const y = Math.max(12, margin.bottom / 2);
    ctx.writeText(dateText, x, y, { font, size });
  }

  // Compute a single global scale so the widest image fits horizontally
  const imageGap = 40;
  const maxWidthPx = Math.max(...validImages.map((i) => i.width));
  const scale = contentWidth / maxWidthPx; // To avoid upscaling, use: Math.min(1, contentWidth / maxWidthPx)

  // Pre-generate QR codes and calculate link spacing for page layout
  const linkSpacingMap = new Map();
  let qrCounter = 0;
  for (const img of validImages) {
    const tuneBaseName = img.filename
      .replace(/\.png$/i, "")
      .replace(new RegExp(`-${escapeRegExp(instrument.file)}-\\d+$`, "i"), "");

    const linkFilePath = path.join("trimmed", `${tuneBaseName}_link`);

    if (fs.existsSync(linkFilePath)) {
      try {
        const linkContent = fs.readFileSync(linkFilePath, "utf8").trim();
        if (linkContent) {
          const links = linkContent
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

          // Generate QR codes (once per tune, not per page)
          if (!qrCodeMap.has(tuneBaseName)) {
            const qrInfos = [];
            for (const rawUrl of links) {
              const url =
                rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
                  ? rawUrl
                  : "https://" + rawUrl;
              const filepath = path.join(qrTempDir, `qr_${qrCounter++}.png`);
              await QRCode.toFile(filepath, url, {
                width: QR_PIXELS,
                margin: 1,
                errorCorrectionLevel: "M",
              });
              qrInfos.push({ url, filepath });
            }
            qrCodeMap.set(tuneBaseName, qrInfos);
          }

          // QR row height: same regardless of number of links (side-by-side)
          const spacing = QR_TOP_MARGIN + QR_CODE_SIZE;
          linkSpacingMap.set(img.filename, spacing);
        }
      } catch (error) {
        console.warn(
          `Failed to generate QR for ${tuneBaseName}:`,
          error.message,
        );
      }
    }
  }

  // Load dance types for labels and dance-type index
  const danceTypes = loadDanceTypes();
  const tuneToDanceTypes = buildTuneToDanceTypesMap(danceTypes);

  // Add linkSpacing to each image's height for accurate page layout
  // Also mark first page of each tune and add label spacing
  const seenTuneNames = new Set();
  // Sort by filename first so page 1 of each tune is encountered first
  const allSorted = [...originalImages].sort((a, b) =>
    a.filename.localeCompare(b.filename, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  for (const img of allSorted) {
    const baseName = tuneBaseNameFromFilename(img.filename, instrument.file);
    const key = baseName.toLowerCase();
    img.isFirstPage = !seenTuneNames.has(key);
    seenTuneNames.add(key);
  }

  originalImages.forEach((img) => {
    img.linkSpacing = linkSpacingMap.get(img.filename) || 0;
  });
  appendixImages.forEach((img) => {
    img.linkSpacing = linkSpacingMap.get(img.filename) || 0;
  });

  // Group images into minimal page sets (order by best fit, not filename)
  // Handle original and appendix images separately
  const originalPages = groupImagesIntoPages(
    originalImages,
    contentHeight,
    scale,
    imageGap,
  );

  let appendixPages = [];
  if (hasAppendix) {
    appendixPages = groupImagesIntoPages(
      appendixImages,
      contentHeight,
      scale,
      imageGap,
    );
  }

  // Combine all pages for processing
  const allPages = [...originalPages, ...appendixPages];

  // Array to store page objects for linking
  const imagePageObjects = [];

  // Array to store index pages for adding links later
  const indexPages = [];

  // Build and render the Index first (so it's the first page[s])
  if (font && validImages.length > 0) {
    // Calculate how many index pages we need
    const lineHeight = 24;
    const titleGap = 30;

    // Create index entries for original images
    indexEntries.push(
      ...originalPages.flatMap((items, pIdx) =>
        items.map((img) => ({
          title: tuneBaseNameFromFilename(img.filename, instrument.file),
          page: pIdx + 1, // no offset from index pages
          pageIndex: pIdx, // store the actual page index for linking
          section: "original",
        })),
      ),
    );

    // Add appendix entries if they exist
    if (hasAppendix) {
      // Add appendix entries (no separator in index - header on page is sufficient)
      indexEntries.push(
        ...appendixPages.flatMap((items, pIdx) =>
          items.map((img) => ({
            title: tuneBaseNameFromFilename(img.filename, instrument.file),
            page: originalPages.length + pIdx + 1,
            pageIndex: originalPages.length + pIdx,
            section: "appendix",
          })),
        ),
      );
    }

    // Sort by title
    const sorted = indexEntries.slice().sort((a, b) =>
      a.title.localeCompare(b.title, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    // Render index pages now — two-column layout
    let idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
    let idxCtx = pdfWriter.startPageContentContext(idxPage);
    let y = pageHeight - margin.top;

    // Store all index pages to add links later
    indexPages.push(idxPage);

    const lineSize = 11;

    // Title on first index page
    idxCtx.writeText(
      `Frome Balfolk Tunes  - (${instrument.title})`,
      margin.left,
      y,
      {
        font,
        size: 26,
      },
    );
    y -= titleGap;

    const colGap = 20; // gap between left and right columns
    const columnWidth = (contentWidth - colGap) / 2;
    const col1Left = margin.left;
    const col1Right = col1Left + columnWidth;
    const col2Left = col1Right + colGap;
    const col2Right = col2Left + columnWidth;
    const gap = 6;
    const dotChar = ".";
    let dotWidth = 0;
    try {
      dotWidth = font.calculateTextDimensions(dotChar, lineSize).width || 0;
    } catch (_) {}

    // Track which column we're in: 0 = left, 1 = right
    let currentCol = 0;
    const colStartY = y; // remember top of columns for right column start

    for (const item of sorted) {
      if (y < margin.bottom + lineHeight) {
        if (currentCol === 0) {
          // Switch to right column
          currentCol = 1;
          y = colStartY;
        } else {
          // Both columns full — new page
          drawDate(idxCtx);
          pdfWriter.writePage(idxPage);
          pageIndex++;

          idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
          idxCtx = pdfWriter.startPageContentContext(idxPage);
          indexPages.push(idxPage);
          y = pageHeight - margin.top;
          currentCol = 0;
        }
      }

      // Determine column boundaries
      const colLeft = currentCol === 0 ? col1Left : col2Left;
      const colRight = currentCol === 0 ? col1Right : col2Right;

      const pageText = String(item.page);
      let numWidth = 0;
      try {
        numWidth = font.calculateTextDimensions(pageText, lineSize).width || 0;
      } catch (_) {}
      const numX = colRight - numWidth;

      let maxTitleWidth = numX - colLeft - gap - (dotWidth || 3);

      let titleText = item.title;
      try {
        // Truncate with ellipsis if needed
        const ellipsis = "…";
        let tWidth =
          font.calculateTextDimensions(titleText, lineSize).width || 0;
        if (tWidth > maxTitleWidth) {
          let low = 0,
            high = titleText.length;
          while (low < high) {
            const mid = Math.floor((low + high + 1) / 2);
            const candidate = titleText.slice(0, mid) + ellipsis;
            const cWidth =
              font.calculateTextDimensions(candidate, lineSize).width || 0;
            if (cWidth <= maxTitleWidth) low = mid;
            else high = mid - 1;
          }
          titleText = titleText.slice(0, low) + ellipsis;
          tWidth = font.calculateTextDimensions(titleText, lineSize).width || 0;
        }

        // Compute dot leader
        const titleWidth = tWidth;
        const dotStartX = colLeft + titleWidth + gap;
        const safetyPad = 2;
        const maxDotsWidth = Math.max(0, numX - gap - dotStartX - safetyPad);

        let dots = "";
        if (maxDotsWidth > 0) {
          if (dotWidth > 0) {
            let count = Math.floor(maxDotsWidth / dotWidth);
            if (count > 0) {
              dots = dotChar.repeat(count);
              try {
                let dotsWidth =
                  font.calculateTextDimensions(dots, lineSize).width || 0;
                while (dots && dotsWidth > maxDotsWidth) {
                  dots = dots.slice(0, -1);
                  dotsWidth =
                    font.calculateTextDimensions(dots, lineSize).width || 0;
                }
              } catch (_) {
                while (dots.length > 0 && dots.length * dotWidth > maxDotsWidth)
                  dots = dots.slice(0, -1);
              }
            }
          } else {
            const approxDotWidth = 3;
            let count = Math.floor(maxDotsWidth / approxDotWidth);
            if (count > 0) dots = dotChar.repeat(count);
          }
        }

        // Handle separators differently - draw without dots or page numbers
        if (item.isSeparator) {
          // Draw separator with centered text and no clickable link
          idxCtx.writeText(titleText, colLeft, y, {
            font,
            size: lineSize + 2,
          });
        } else {
          // Draw: title (left), dots (middle), page number (right edge of column)
          idxCtx.writeText(titleText, colLeft, y, { font, size: lineSize });
          if (dots)
            idxCtx.writeText(dots, dotStartX, y, { font, size: lineSize });
          idxCtx.writeText(pageText, numX, y, { font, size: lineSize });

          // Add clickable link area covering the entire line
          // We'll need to update this link later once we have the page objects
          const linkHeight = lineHeight;
          const linkY = y - 2; // slight adjustment for better click area
          const linkWidth = colRight - colLeft;

          // Store link info for later (after we create the image pages)
          if (!idxPage._linkAnnotations) {
            idxPage._linkAnnotations = [];
          }
          idxPage._linkAnnotations.push({
            x: colLeft,
            y: linkY,
            width: linkWidth,
            height: linkHeight,
            targetPageIndex: item.pageIndex,
          });
        }
      } catch (_) {
        // Fallback: just draw minimally if anything fails
        idxCtx.writeText(titleText, colLeft, y, { font, size: lineSize });
        idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
      }

      y -= lineHeight;
    }

    // finalize alphabetical index page
    drawDate(idxCtx);
    pdfWriter.writePage(idxPage);
    pageIndex++;

    // ----------------------------------------------------------------
    // Dance-Type Index (tunes grouped by dance type)
    // ----------------------------------------------------------------
    // Build dance-type → [{title, page, pageIndex}] from index entries
    const danceTypeIndex = new Map();
    const seenTunesForDanceType = new Map(); // avoid duplicate entries per dance type
    for (const entry of indexEntries) {
      const key = entry.title.trim().toLowerCase();
      const types = tuneToDanceTypes.get(key) || ["Unclassified"];
      for (const dt of types) {
        if (!danceTypeIndex.has(dt)) {
          danceTypeIndex.set(dt, []);
          seenTunesForDanceType.set(dt, new Set());
        }
        // Only add first occurrence of each tune per dance type
        if (!seenTunesForDanceType.get(dt).has(key)) {
          seenTunesForDanceType.get(dt).add(key);
          danceTypeIndex.get(dt).push(entry);
        }
      }
    }

    // Sort entries within each dance type alphabetically
    for (const [, entries] of danceTypeIndex) {
      entries.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
    }

    // Dance type names sorted alphabetically, skip empty ones
    const danceTypeNames = [...danceTypeIndex.keys()]
      .filter((name) => danceTypeIndex.get(name).length > 0)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    if (danceTypeNames.length > 0) {
      // Start first dance-type index page
      idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      idxCtx = pdfWriter.startPageContentContext(idxPage);
      y = pageHeight - margin.top;
      indexPages.push(idxPage);

      const sectionHeaderLineSize = 13;
      const sectionHeaderLineHeight = 28;

      // Title
      idxCtx.writeText("Dance Type Index", margin.left, y, {
        font,
        size: 22,
      });
      y -= titleGap;

      currentCol = 0;
      const dtColStartY = y;

      function ensureDtSpace(needed) {
        if (y >= margin.bottom + needed) return;
        if (currentCol === 0) {
          currentCol = 1;
          y = dtColStartY;
        } else {
          drawDate(idxCtx);
          pdfWriter.writePage(idxPage);
          pageIndex++;

          idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
          idxCtx = pdfWriter.startPageContentContext(idxPage);
          indexPages.push(idxPage);
          y = pageHeight - margin.top;
          currentCol = 0;
        }
      }

      for (const dtName of danceTypeNames) {
        const dtEntries = danceTypeIndex.get(dtName);
        if (!dtEntries || dtEntries.length === 0) continue;

        // Ensure space for header + at least one entry
        ensureDtSpace(sectionHeaderLineHeight + lineHeight);

        const colLeft = currentCol === 0 ? col1Left : col2Left;

        // Draw dance-type header
        idxCtx.writeText(dtName, colLeft, y, {
          font,
          size: sectionHeaderLineSize,
        });
        y -= sectionHeaderLineHeight;

        // Draw each tune entry
        for (const item of dtEntries) {
          ensureDtSpace(lineHeight);

          const cLeft = currentCol === 0 ? col1Left : col2Left;
          const cRight = currentCol === 0 ? col1Right : col2Right;
          const entryLeft = cLeft + 8; // indent under header

          const pageText = String(item.page);
          let numWidth = 0;
          try {
            numWidth =
              font.calculateTextDimensions(pageText, lineSize).width || 0;
          } catch (_) {}
          const numX = cRight - numWidth;

          let maxTitleWidth = numX - entryLeft - gap - (dotWidth || 3);

          let titleText = item.title;
          try {
            const ellipsis = "…";
            let tWidth =
              font.calculateTextDimensions(titleText, lineSize).width || 0;
            if (tWidth > maxTitleWidth) {
              let low = 0,
                high = titleText.length;
              while (low < high) {
                const mid = Math.floor((low + high + 1) / 2);
                const candidate = titleText.slice(0, mid) + ellipsis;
                const cWidth =
                  font.calculateTextDimensions(candidate, lineSize).width || 0;
                if (cWidth <= maxTitleWidth) low = mid;
                else high = mid - 1;
              }
              titleText = titleText.slice(0, low) + ellipsis;
              tWidth =
                font.calculateTextDimensions(titleText, lineSize).width || 0;
            }

            const titleWidth = tWidth;
            const dotStartX = entryLeft + titleWidth + gap;
            const safetyPad = 2;
            const maxDotsWidth = Math.max(
              0,
              numX - gap - dotStartX - safetyPad,
            );

            let dots = "";
            if (maxDotsWidth > 0) {
              if (dotWidth > 0) {
                let count = Math.floor(maxDotsWidth / dotWidth);
                if (count > 0) {
                  dots = dotChar.repeat(count);
                  try {
                    let dotsWidth =
                      font.calculateTextDimensions(dots, lineSize).width || 0;
                    while (dots && dotsWidth > maxDotsWidth) {
                      dots = dots.slice(0, -1);
                      dotsWidth =
                        font.calculateTextDimensions(dots, lineSize).width || 0;
                    }
                  } catch (_) {
                    while (
                      dots.length > 0 &&
                      dots.length * dotWidth > maxDotsWidth
                    )
                      dots = dots.slice(0, -1);
                  }
                }
              } else {
                const approxDotWidth = 3;
                let count = Math.floor(maxDotsWidth / approxDotWidth);
                if (count > 0) dots = dotChar.repeat(count);
              }
            }

            idxCtx.writeText(titleText, entryLeft, y, {
              font,
              size: lineSize,
            });
            if (dots)
              idxCtx.writeText(dots, dotStartX, y, { font, size: lineSize });
            idxCtx.writeText(pageText, numX, y, { font, size: lineSize });

            // Clickable link
            if (!idxPage._linkAnnotations) {
              idxPage._linkAnnotations = [];
            }
            idxPage._linkAnnotations.push({
              x: cLeft,
              y: y - 2,
              width: cRight - cLeft,
              height: lineHeight,
              targetPageIndex: item.pageIndex,
            });
          } catch (_) {
            idxCtx.writeText(titleText, entryLeft, y, {
              font,
              size: lineSize,
            });
            idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
          }

          y -= lineHeight;
        }
      }

      // Finalize last dance-type index page
      drawDate(idxCtx);
      pdfWriter.writePage(idxPage);
      pageIndex++;
    }
  }

  // Start first image page (after index pages)
  let page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  let contentContext = pdfWriter.startPageContentContext(page);
  let currentY = pageHeight - margin.top;

  // Store the first image page
  imagePageObjects.push(page);

  // Render page-by-page based on grouping
  for (let p = 0; p < allPages.length; p++) {
    // Check if we're starting the appendix section
    const isAppendixStart = hasAppendix && p === originalPages.length;

    if (p > 0) {
      // finalize previous image page and start a new one
      if (font) {
        drawPageNumber(contentContext, imagePageNumber + 1);
        drawDate(contentContext);
      }
      pdfWriter.writePage(page);
      imagePageNumber++;
      pageIndex++;

      page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      contentContext = pdfWriter.startPageContentContext(page);
      currentY = pageHeight - margin.top;

      // Store this image page
      imagePageObjects.push(page);
    }

    // If starting appendix, add some visual separation
    if (isAppendixStart && font) {
      // Add "New Tunes" header at top of first appendix page
      const headerY = pageHeight - margin.top;
      contentContext.writeText("New Tunes", margin.left, headerY, {
        font,
        size: 20,
      });
      currentY = headerY - 40; // Space after header
    }

    for (const img of allPages[p]) {
      const wPts = img.width * scale;
      const hPts = img.height * scale;

      // Check if this image needs a dance-type label
      const baseName = tuneBaseNameFromFilename(img.filename, instrument.file);
      const types = tuneToDanceTypes.get(baseName.toLowerCase());
      const needsLabel = img.isFirstPage && types && types.length > 0;

      // Safety: if something doesn't fit due to rounding, spill to a new page
      if (currentY - hPts < margin.bottom) {
        if (font) {
          drawPageNumber(contentContext, imagePageNumber + 1);
          drawDate(contentContext);
        }
        pdfWriter.writePage(page);
        imagePageNumber++;
        pageIndex++;

        page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
        contentContext = pdfWriter.startPageContentContext(page);
        currentY = pageHeight - margin.top;

        // Store this overflow page
        imagePageObjects.push(page);
      }

      // Draw dance-type label inline with top of image (to the left)
      const x = margin.left + (contentWidth - wPts) / 2;
      const y = currentY - hPts;

      if (font && needsLabel) {
        const labelText = `[${types.join(", ")}]`;
        // Position label so its top aligns with image top (offset down by font size)
        contentContext.writeText(
          labelText,
          margin.left,
          currentY - DANCE_LABEL_SIZE - 2,
          {
            font,
            size: DANCE_LABEL_SIZE,
          },
        );
      }

      contentContext.drawImage(x, y, img.path, {
        transformation: { width: wPts, height: hPts },
      });

      let linkSpacing = 0;

      // Draw QR codes for any links associated with this tune
      if (font) {
        const tuneBaseName = img.filename
          .replace(/\.png$/i, "")
          .replace(
            new RegExp(`-${escapeRegExp(instrument.file)}-\\d+$`, "i"),
            "",
          );

        const qrInfos = qrCodeMap.get(tuneBaseName);
        if (qrInfos && qrInfos.length > 0) {
          if (!page._linkAnnotations) {
            page._linkAnnotations = [];
          }

          // Calculate horizontal layout for side-by-side QR codes
          const totalQRWidth =
            qrInfos.length * QR_CODE_SIZE + (qrInfos.length - 1) * QR_CODE_GAP;
          let qrX = margin.left + (contentWidth - totalQRWidth) / 2;
          const qrBottomY = y - QR_TOP_MARGIN - QR_CODE_SIZE;

          for (const qrInfo of qrInfos) {
            // Draw QR code image
            contentContext.drawImage(qrX, qrBottomY, qrInfo.filepath, {
              transformation: {
                width: QR_CODE_SIZE,
                height: QR_CODE_SIZE,
              },
            });

            // Add clickable link annotation over QR code area
            page._linkAnnotations.push({
              x: qrX,
              y: qrBottomY,
              width: QR_CODE_SIZE,
              height: QR_CODE_SIZE,
              url: qrInfo.url,
              isExternalLink: true,
            });

            console.log(`  QR code for ${tuneBaseName}: ${qrInfo.url}`);
            qrX += QR_CODE_SIZE + QR_CODE_GAP;
          }

          linkSpacing = QR_TOP_MARGIN + QR_CODE_SIZE;
        }
      }

      currentY -= hPts + imageGap + linkSpacing;
    }
  }

  // Finalize the last image page
  if (font) {
    drawPageNumber(contentContext, imagePageNumber + 1);
    drawDate(contentContext);
  }
  pdfWriter.writePage(page);
  imagePageNumber++;
  pageIndex++;

  // Now add the clickable links to index pages using pdf-lib
  // Use a post-processing approach
  if (font && indexPages.length > 0 && imagePageObjects.length > 0) {
    try {
      // Close current writer
      pdfWriter.end();

      // Load the PDF with pdf-lib
      const pdfBytes = fs.readFileSync(outputPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      // Add links to index pages
      let indexPageNum = 0;
      for (const idxPage of indexPages) {
        if (idxPage._linkAnnotations && idxPage._linkAnnotations.length > 0) {
          const page = pages[indexPageNum];

          for (const linkInfo of idxPage._linkAnnotations) {
            // Calculate target page number (index pages + target image page index)
            const targetPageNum = indexPages.length + linkInfo.targetPageIndex;

            if (targetPageNum < pages.length) {
              const targetPage = pages[targetPageNum];

              // Create link annotation using pdf-lib's low-level API
              const linkAnnotation = pdfDoc.context.obj({
                Type: "Annot",
                Subtype: "Link",
                Rect: [
                  linkInfo.x,
                  linkInfo.y,
                  linkInfo.x + linkInfo.width,
                  linkInfo.y + linkInfo.height,
                ],
                Border: [0, 0, 0],
                C: [0, 0, 1], // Optional: blue color for link (invisible)
                A: {
                  Type: "Action",
                  S: "GoTo",
                  D: [targetPage.ref, "XYZ", null, null, null],
                },
              });

              const linkAnnotationRef = pdfDoc.context.register(linkAnnotation);

              // Add annotation to the page
              const annots = page.node.Annots();
              if (annots) {
                annots.push(linkAnnotationRef);
              } else {
                page.node.set(
                  pdfDoc.context.obj("Annots"),
                  pdfDoc.context.obj([linkAnnotationRef]),
                );
              }
            }
          }
        }
        indexPageNum++;
      }

      // Process external links on image pages
      for (let pageNum = 0; pageNum < imagePageObjects.length; pageNum++) {
        const imagePage = imagePageObjects[pageNum];
        if (
          imagePage._linkAnnotations &&
          imagePage._linkAnnotations.length > 0
        ) {
          const pdfLibPage = pages[indexPages.length + pageNum]; // Offset by index pages

          for (const linkInfo of imagePage._linkAnnotations) {
            if (linkInfo.isExternalLink) {
              try {
                // Use pdf-lib's high-level API for URL links
                const { PDFName, PDFString } = await import("pdf-lib");

                // Create external URL link annotation with proper URI encoding
                const urlLinkAnnotation = pdfDoc.context.obj({
                  Type: "Annot",
                  Subtype: "Link",
                  Rect: [
                    linkInfo.x,
                    linkInfo.y,
                    linkInfo.x + linkInfo.width,
                    linkInfo.y + linkInfo.height,
                  ],
                  Border: [0, 0, 0],
                  H: "I", // Highlight mode: Invert
                  A: {
                    Type: "Action",
                    S: "URI",
                    URI: PDFString.of(linkInfo.url),
                  },
                });

                const urlLinkRef = pdfDoc.context.register(urlLinkAnnotation);

                // Add annotation to the page
                const annots = pdfLibPage.node.Annots();
                if (annots) {
                  annots.push(urlLinkRef);
                } else {
                  pdfLibPage.node.set(
                    pdfDoc.context.obj("Annots"),
                    pdfDoc.context.obj([urlLinkRef]),
                  );
                }

                console.log(`✓ Added clickable link: ${linkInfo.url}`);
              } catch (error) {
                console.warn(`Failed to add link: ${error.message}`);
              }
            }
          }
        }
      }

      // Save the modified PDF
      const modifiedPdfBytes = await pdfDoc.save();
      fs.writeFileSync(outputPath, modifiedPdfBytes);

      console.log(`✓ Added clickable links to table of contents`);
    } catch (error) {
      console.warn("Note: Could not create clickable links:", error.message);
    }

    // Clean up QR temp files
    try {
      fs.rmSync(qrTempDir, { recursive: true, force: true });
    } catch (_) {}
    return; // Exit early since we already called end()
  }

  // Finalize the PDF
  pdfWriter.end();

  // Clean up QR temp files
  try {
    fs.rmSync(qrTempDir, { recursive: true, force: true });
  } catch (_) {}

  console.log(
    `${instrument.file}\n   Total pages ${pageIndex}\n   Total Tunes: ${imageFiles.length}`,
  );
}

// Execute the function
(async () => {
  for (const instrument of instruments) {
    try {
      await combinePDFs(instrument);
    } catch (error) {
      console.error(`Error combining images for ${instrument.file}:`, error);
    }
  }
})();
