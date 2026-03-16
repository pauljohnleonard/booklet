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

// Section header configuration
const SECTION_HEADER_SIZE = 18; // Font size for section headers
const SECTION_HEADER_HEIGHT = 24; // Space occupied by header text
const SECTION_HEADER_GAP = 12; // Gap below section header line
const SECTION_TOTAL_HEIGHT = SECTION_HEADER_HEIGHT + SECTION_HEADER_GAP;

// Per-tune dance-type label (small tag above first page of each tune)
const DANCE_LABEL_SIZE = 9; // Font size
const DANCE_LABEL_HEIGHT = 14; // Total vertical space consumed

// ---------------------------------------------------------------------------
// Dance-type section helpers
// ---------------------------------------------------------------------------

/**
 * Load dance types from dance_types.json.
 * Returns the "dances" object: { danceType: [tuneName, ...], ... }
 */
function loadDanceTypes() {
  const danceTypesPath = "dance_types.json";
  if (!fs.existsSync(danceTypesPath)) {
    console.warn("dance_types.json not found — all tunes will be Unclassified");
    return {};
  }
  const data = JSON.parse(fs.readFileSync(danceTypesPath, "utf8"));
  return data.dances || {};
}

/**
 * Build a reverse map: tuneName (lowercase, trimmed) → danceType.
 * If a tune appears in a specific type AND in "Unclassified", the specific
 * type wins so the user doesn't need to maintain perfect deduplication.
 */
function buildTuneToDanceTypeMap(danceTypes) {
  const map = new Map();
  for (const [danceType, tunes] of Object.entries(danceTypes)) {
    for (const tune of tunes) {
      const key = tune.trim().toLowerCase();
      if (!map.has(key) || danceType !== "Unclassified") {
        map.set(key, danceType);
      }
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

/**
 * Partition images into sections keyed by dance type.
 * Returns Map<danceType, image[]> with images sorted by filename inside each
 * section so multi-page tunes stay in order.
 */
function groupImagesBySections(images, tuneToDanceType, instrumentFile) {
  const sections = new Map();

  for (const img of images) {
    const baseName = tuneBaseNameFromFilename(img.filename, instrumentFile);
    const danceType =
      tuneToDanceType.get(baseName.toLowerCase()) || "Unclassified";

    // Tag each image with its dance type and tune base name
    img.danceType = danceType;
    img.tuneBaseName = baseName;

    if (!sections.has(danceType)) {
      sections.set(danceType, []);
    }
    sections.get(danceType).push(img);
  }

  // Sort images inside each section alphabetically by filename
  for (const [, imgs] of sections) {
    imgs.sort((a, b) =>
      a.filename.localeCompare(b.filename, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }

  // Mark the first page of each tune (only that page gets the dance-type label)
  const seenTunes = new Set();
  for (const [, imgs] of sections) {
    for (const img of imgs) {
      const key = img.tuneBaseName.toLowerCase();
      img.isFirstPage = !seenTunes.has(key);
      seenTunes.add(key);
    }
  }

  return sections;
}

/**
 * Return section names sorted alphabetically.
 * Sections with no images are omitted.
 */
function getSortedSectionNames(sections) {
  return [...sections.keys()]
    .filter((name) => sections.get(name).length > 0)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * Validate that dance_types.json and actual image files are in sync.
 * Warns about:
 *   - Tunes found as image files but not listed in dance_types.json
 *   - Tunes listed in dance_types.json but with no matching image files
 * Only runs for the first instrument to avoid duplicate noise.
 */
function validateDanceTypes(danceTypes, images, instrumentFile) {
  // Build set of unique tune base names from actual image files
  const fileTuneNames = new Set();
  for (const img of images) {
    fileTuneNames.add(
      tuneBaseNameFromFilename(img.filename, instrumentFile).toLowerCase(),
    );
  }

  // Build set of all tune names mentioned in dance_types.json
  const jsonTuneNames = new Set();
  for (const [, tunes] of Object.entries(danceTypes)) {
    for (const tune of tunes) {
      jsonTuneNames.add(tune.trim().toLowerCase());
    }
  }

  // Tunes in files but not in dance_types.json
  const missingFromJson = [...fileTuneNames].filter(
    (name) => !jsonTuneNames.has(name),
  );
  if (missingFromJson.length > 0) {
    console.warn(
      "\n⚠  Tunes found in image files but NOT in dance_types.json:",
    );
    for (const name of missingFromJson.sort()) {
      console.warn(`   + ${name}`);
    }
    console.warn(
      "   → Add them to dance_types.json under the correct dance type.\n",
    );
  }

  // Tunes in dance_types.json but not found as image files
  const missingFromFiles = [...jsonTuneNames].filter(
    (name) => !fileTuneNames.has(name),
  );
  if (missingFromFiles.length > 0) {
    console.warn(
      "\n⚠  Tunes listed in dance_types.json but NO matching image files found:",
    );
    for (const name of missingFromFiles.sort()) {
      console.warn(`   - ${name}`);
    }
    console.warn(
      "   → Remove them from dance_types.json or generate the missing score files.\n",
    );
  }

  if (missingFromJson.length === 0 && missingFromFiles.length === 0) {
    console.log("✓ dance_types.json is in sync with image files.");
  }
}

// ---------------------------------------------------------------------------
// Sequential layout planner (replaces the old BFD / knapsack optimiser)
// ---------------------------------------------------------------------------

/**
 * Plan a simple top-to-bottom page layout with section headers.
 *
 * Returns an array of pages.  Each page is an array of items:
 *   { type: "sectionHeader", title }
 *   { type: "image", ...imageProps }
 *
 * The planner mirrors the real rendering coordinates so page numbers computed
 * here match the final PDF exactly.
 */
function planSequentialLayout(
  sections,
  sectionOrder,
  contentHeight,
  scale,
  imageGap,
) {
  const pages = [];
  let currentPage = [];
  let currentY = contentHeight; // remaining vertical space (decreasing)

  for (const sectionName of sectionOrder) {
    const images = sections.get(sectionName);
    if (!images || images.length === 0) continue;

    const firstImgHeight =
      images[0].height * scale + (images[0].linkSpacing || 0);

    // Make sure the section header + at least the first image fit.
    // If not, spill to a new page.
    if (
      currentPage.length > 0 &&
      currentY < SECTION_TOTAL_HEIGHT + firstImgHeight
    ) {
      pages.push(currentPage);
      currentPage = [];
      currentY = contentHeight;
    }

    // Section header item
    currentPage.push({ type: "sectionHeader", title: sectionName });
    currentY -= SECTION_TOTAL_HEIGHT;

    // Place images sequentially
    for (const img of images) {
      // Add space for dance-type label on first page of classified tunes
      const labelExtra =
        img.isFirstPage && img.danceType && img.danceType !== "Unclassified"
          ? DANCE_LABEL_HEIGHT
          : 0;
      const scaledHeight =
        img.height * scale + (img.linkSpacing || 0) + labelExtra;

      if (currentY < scaledHeight && currentPage.length > 0) {
        pages.push(currentPage);
        currentPage = [];
        currentY = contentHeight;
      }

      currentPage.push({ type: "image", ...img });
      currentY -= scaledHeight + imageGap;
    }
  }

  if (currentPage.length > 0) {
    pages.push(currentPage);
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Main PDF generation
// ---------------------------------------------------------------------------

/**
 * Combines PNG files from the trimmed folder into a single PDF document,
 * organised by dance-type sections read from dance_types.json.
 */
async function combinePDFs(instrument) {
  const trimmedDir = "trimmed";

  // Check if directory exists
  if (!fs.existsSync(trimmedDir)) {
    console.error("Error: 'trimmed' directory not found!");
    return;
  }

  // Get all PNG files from the trimmed directory
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

  // Analyze each PNG to get image information
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

  const validImages = imageInfo.filter((info) => info !== null);

  if (validImages.length === 0) {
    console.error("No valid PNG files to render.");
    return;
  }

  // ------------------------------------------------------------------
  // Baseline / appendix separation (unchanged)
  // ------------------------------------------------------------------
  const baselineFile = `baseline_${instrument.file.toLowerCase()}.txt`;
  let originalImages = validImages;
  let appendixImages = [];
  let hasAppendix = false;

  if (fs.existsSync(baselineFile)) {
    console.log(`Found baseline file: ${baselineFile}`);

    const baselineContent = fs.readFileSync(baselineFile, "utf8");
    const baselineImagePaths = baselineContent
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.trim());

    const baselineFilenames = new Set(
      baselineImagePaths.map((filepath) => path.basename(filepath)),
    );

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
    console.log("No baseline file found — generating complete booklet");
  }

  // ------------------------------------------------------------------
  // QR-code pre-generation
  // ------------------------------------------------------------------
  const qrTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "booklet-qr-"));
  const qrCodeMap = new Map(); // tuneBaseName → [{url, filepath}]

  const outputPath = `booklets/${instrument.file}.pdf`;
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create PDF writer
  const pdfWriter = muhammara.createWriter(outputPath);

  let pageIndex = 0;
  let imagePageNumber = 0;
  const indexEntries = [];

  // Font loading
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

  // Page layout constants (points; 72 pt = 1 in)
  const margin = { top: 36, bottom: 30, left: 40, right: 40 };
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const contentWidth = pageWidth - margin.left - margin.right;
  const contentHeight = pageHeight - margin.top - margin.bottom;

  // Drawing helpers
  function drawPageNumber(ctx, number) {
    if (!font) return;
    const text = String(number);
    const size = 10;
    let textWidth = 0;
    try {
      textWidth = font.calculateTextDimensions(text, size).width || 0;
    } catch (_) {}
    const x = pageWidth - margin.right - textWidth;
    const y = Math.max(12, margin.bottom / 2);
    ctx.writeText(text, x, y, { font, size });
  }

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

  // Global image scale (widest image fills content width)
  const imageGap = 40;
  const maxWidthPx = Math.max(...validImages.map((i) => i.width));
  const scale = contentWidth / maxWidthPx;

  // Pre-generate QR codes and calculate linkSpacing per image
  const linkSpacingMap = new Map();
  let qrCounter = 0;
  for (const img of validImages) {
    const tuneBaseName = tuneBaseNameFromFilename(
      img.filename,
      instrument.file,
    );

    const linkFilePath = path.join("trimmed", `${tuneBaseName}_link`);

    if (fs.existsSync(linkFilePath)) {
      try {
        const linkContent = fs.readFileSync(linkFilePath, "utf8").trim();
        if (linkContent) {
          const links = linkContent
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

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

  // Attach linkSpacing to each image object
  originalImages.forEach((img) => {
    img.linkSpacing = linkSpacingMap.get(img.filename) || 0;
  });
  appendixImages.forEach((img) => {
    img.linkSpacing = linkSpacingMap.get(img.filename) || 0;
  });

  // ------------------------------------------------------------------
  // Build sectioned layout for original images
  // ------------------------------------------------------------------
  const danceTypes = loadDanceTypes();
  const tuneToDanceType = buildTuneToDanceTypeMap(danceTypes);

  const originalSections = groupImagesBySections(
    originalImages,
    tuneToDanceType,
    instrument.file,
  );
  const sectionOrder = getSortedSectionNames(originalSections);

  // Validate dance_types.json against actual files (first instrument only)
  if (instrument === instruments[0]) {
    validateDanceTypes(danceTypes, originalImages, instrument.file);
  }

  console.log(`Sections for ${instrument.file}:`);
  for (const name of sectionOrder) {
    console.log(`  ${name}: ${originalSections.get(name).length} images`);
  }

  const originalPages = planSequentialLayout(
    originalSections,
    sectionOrder,
    contentHeight,
    scale,
    imageGap,
  );

  // Appendix images: simple sequential (no dance-type sections)
  let appendixPages = [];
  if (hasAppendix) {
    const appendixSections = new Map([["New Tunes", appendixImages]]);
    appendixPages = planSequentialLayout(
      appendixSections,
      ["New Tunes"],
      contentHeight,
      scale,
      imageGap,
    );
  }

  const allPages = [...originalPages, ...appendixPages];

  // ------------------------------------------------------------------
  // Build index entries from the layout plan
  // ------------------------------------------------------------------
  allPages.forEach((page, pageIdx) => {
    for (const item of page) {
      if (item.type !== "image") continue;
      const baseName = tuneBaseNameFromFilename(item.filename, instrument.file);
      const danceType =
        tuneToDanceType.get(baseName.toLowerCase()) || "Unclassified";
      const isAppendix = pageIdx >= originalPages.length;
      indexEntries.push({
        title: baseName,
        danceType,
        page: pageIdx + 1,
        pageIndex: pageIdx,
        section: isAppendix ? "appendix" : "original",
      });
    }
  });

  // ------------------------------------------------------------------
  // Page-object tracking for clickable links
  // ------------------------------------------------------------------
  const imagePageObjects = [];
  const indexPages = [];

  // ------------------------------------------------------------------
  // Render the Index (first page(s) of the PDF)
  // ------------------------------------------------------------------
  if (font && validImages.length > 0) {
    const lineHeight = 24;
    const titleGap = 30;

    // Group index entries by dance type, sorted alphabetically within each section
    const indexBySection = new Map();
    for (const entry of indexEntries) {
      const dt = entry.danceType || "Unclassified";
      if (!indexBySection.has(dt)) indexBySection.set(dt, []);
      indexBySection.get(dt).push(entry);
    }
    // Sort entries within each section by title
    for (const [, entries] of indexBySection) {
      entries.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
    }
    // Section names sorted alphabetically
    const indexSectionNames = [...indexBySection.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );

    // Start first index page
    let idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
    let idxCtx = pdfWriter.startPageContentContext(idxPage);
    let y = pageHeight - margin.top;
    indexPages.push(idxPage);

    const lineSize = 11;
    const sectionHeaderLineSize = 13;
    const sectionHeaderLineHeight = 28; // extra space for section headers

    // Title
    idxCtx.writeText(
      `Frome Balfolk Tunes  - (${instrument.title})`,
      margin.left,
      y,
      { font, size: 26 },
    );
    y -= titleGap;

    // Two-column layout
    const colGap = 20;
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

    let currentCol = 0;
    const colStartY = y;

    // Helper: advance to next column or page if needed
    function ensureIndexSpace(needed) {
      if (y >= margin.bottom + needed) return; // enough space
      if (currentCol === 0) {
        currentCol = 1;
        y = colStartY;
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

    for (const sectionName of indexSectionNames) {
      const sectionEntries = indexBySection.get(sectionName);
      if (!sectionEntries || sectionEntries.length === 0) continue;

      // Ensure space for section header + at least one entry
      ensureIndexSpace(sectionHeaderLineHeight + lineHeight);

      const colLeft = currentCol === 0 ? col1Left : col2Left;

      // Draw section header (bold-ish via larger size)
      idxCtx.writeText(sectionName, colLeft, y, {
        font,
        size: sectionHeaderLineSize,
      });
      y -= sectionHeaderLineHeight;

      // Draw each tune entry in this section
      for (const item of sectionEntries) {
        ensureIndexSpace(lineHeight);

        const cLeft = currentCol === 0 ? col1Left : col2Left;
        const cRight = currentCol === 0 ? col1Right : col2Right;
        // Indent entries slightly under the section header
        const entryLeft = cLeft + 8;

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

          idxCtx.writeText(titleText, entryLeft, y, { font, size: lineSize });
          if (dots)
            idxCtx.writeText(dots, dotStartX, y, { font, size: lineSize });
          idxCtx.writeText(pageText, numX, y, { font, size: lineSize });

          // Store clickable-link info for post-processing
          const linkHeight = lineHeight;
          const linkY = y - 2;
          const linkWidth = cRight - cLeft;

          if (!idxPage._linkAnnotations) {
            idxPage._linkAnnotations = [];
          }
          idxPage._linkAnnotations.push({
            x: cLeft,
            y: linkY,
            width: linkWidth,
            height: linkHeight,
            targetPageIndex: item.pageIndex,
          });
        } catch (_) {
          idxCtx.writeText(titleText, entryLeft, y, { font, size: lineSize });
          idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
        }

        y -= lineHeight;
      }
    }

    drawDate(idxCtx);
    pdfWriter.writePage(idxPage);
    pageIndex++;

    // ----------------------------------------------------------------
    // Alphabetical Index (flat list, all tunes A-Z)
    // ----------------------------------------------------------------
    const alphaEntries = indexEntries.slice().sort((a, b) =>
      a.title.localeCompare(b.title, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    // Start first alpha-index page
    idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
    idxCtx = pdfWriter.startPageContentContext(idxPage);
    y = pageHeight - margin.top;
    indexPages.push(idxPage);

    // Title
    idxCtx.writeText("Alphabetical Index", margin.left, y, {
      font,
      size: 22,
    });
    y -= titleGap;

    currentCol = 0;
    const alphaColStartY = y;

    // Reuse ensureIndexSpace but reset colStartY reference for this section
    function ensureAlphaSpace(needed) {
      if (y >= margin.bottom + needed) return;
      if (currentCol === 0) {
        currentCol = 1;
        y = alphaColStartY;
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

    for (const item of alphaEntries) {
      ensureAlphaSpace(lineHeight);

      const cLeft = currentCol === 0 ? col1Left : col2Left;
      const cRight = currentCol === 0 ? col1Right : col2Right;

      const pageText = String(item.page);
      let numWidth = 0;
      try {
        numWidth = font.calculateTextDimensions(pageText, lineSize).width || 0;
      } catch (_) {}
      const numX = cRight - numWidth;

      let maxTitleWidth = numX - cLeft - gap - (dotWidth || 3);

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
          tWidth = font.calculateTextDimensions(titleText, lineSize).width || 0;
        }

        const titleWidth = tWidth;
        const dotStartX = cLeft + titleWidth + gap;
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

        idxCtx.writeText(titleText, cLeft, y, { font, size: lineSize });
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
        idxCtx.writeText(titleText, cLeft, y, { font, size: lineSize });
        idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
      }

      y -= lineHeight;
    }

    drawDate(idxCtx);
    pdfWriter.writePage(idxPage);
    pageIndex++;
  }

  // ------------------------------------------------------------------
  // Render content pages (section headers + images)
  // ------------------------------------------------------------------
  let page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  let contentContext = pdfWriter.startPageContentContext(page);
  let currentY = pageHeight - margin.top;
  imagePageObjects.push(page);

  for (let p = 0; p < allPages.length; p++) {
    if (p > 0) {
      // Finalize the previous page
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
      imagePageObjects.push(page);
    }

    for (const item of allPages[p]) {
      // --- Section header ---
      if (item.type === "sectionHeader") {
        if (font) {
          // Draw the section title
          contentContext.writeText(item.title, margin.left, currentY, {
            font,
            size: SECTION_HEADER_SIZE,
          });

          // Draw a thin separator line under the header
          const lineY = currentY - SECTION_HEADER_HEIGHT + 4;
          try {
            const rule = "─".repeat(80);
            contentContext.writeText(rule, margin.left, lineY, {
              font,
              size: 6,
            });
          } catch (_) {
            // Some fonts lack the ─ glyph; skip if unsupported
          }
        }
        currentY -= SECTION_TOTAL_HEIGHT;
        continue;
      }

      // --- Image ---
      const img = item;
      const wPts = img.width * scale;
      const hPts = img.height * scale;

      // Dance-type label above first page of classified tunes
      const showLabel =
        font &&
        img.isFirstPage &&
        img.danceType &&
        img.danceType !== "Unclassified";
      const labelExtra = showLabel ? DANCE_LABEL_HEIGHT : 0;

      // Safety: spill to a new page if image + label doesn't fit
      if (currentY - hPts - labelExtra < margin.bottom) {
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
        imagePageObjects.push(page);
      }

      // Draw the dance-type label if applicable
      if (showLabel) {
        const labelText = `[${img.danceType}]`;
        contentContext.writeText(labelText, margin.left, currentY, {
          font,
          size: DANCE_LABEL_SIZE,
        });
        currentY -= DANCE_LABEL_HEIGHT;
      }

      const x = margin.left + (contentWidth - wPts) / 2;
      const y = currentY - hPts;

      contentContext.drawImage(x, y, img.path, {
        transformation: { width: wPts, height: hPts },
      });

      // QR codes for linked tunes
      let linkSpacing = 0;
      if (font) {
        const tuneBaseName = tuneBaseNameFromFilename(
          img.filename,
          instrument.file,
        );

        const qrInfos = qrCodeMap.get(tuneBaseName);
        if (qrInfos && qrInfos.length > 0) {
          if (!page._linkAnnotations) {
            page._linkAnnotations = [];
          }

          const totalQRWidth =
            qrInfos.length * QR_CODE_SIZE + (qrInfos.length - 1) * QR_CODE_GAP;
          let qrX = margin.left + (contentWidth - totalQRWidth) / 2;
          const qrBottomY = y - QR_TOP_MARGIN - QR_CODE_SIZE;

          for (const qrInfo of qrInfos) {
            contentContext.drawImage(qrX, qrBottomY, qrInfo.filepath, {
              transformation: {
                width: QR_CODE_SIZE,
                height: QR_CODE_SIZE,
              },
            });

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

  // ------------------------------------------------------------------
  // Post-process: add clickable links (index → pages, QR → URLs)
  // ------------------------------------------------------------------
  if (font && indexPages.length > 0 && imagePageObjects.length > 0) {
    try {
      pdfWriter.end();

      const pdfBytes = fs.readFileSync(outputPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      // Index-page internal links
      let indexPageNum = 0;
      for (const idxPage of indexPages) {
        if (idxPage._linkAnnotations && idxPage._linkAnnotations.length > 0) {
          const pg = pages[indexPageNum];

          for (const linkInfo of idxPage._linkAnnotations) {
            const targetPageNum = indexPages.length + linkInfo.targetPageIndex;

            if (targetPageNum < pages.length) {
              const targetPage = pages[targetPageNum];

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
                C: [0, 0, 1],
                A: {
                  Type: "Action",
                  S: "GoTo",
                  D: [targetPage.ref, "XYZ", null, null, null],
                },
              });

              const linkAnnotationRef = pdfDoc.context.register(linkAnnotation);

              const annots = pg.node.Annots();
              if (annots) {
                annots.push(linkAnnotationRef);
              } else {
                pg.node.set(
                  pdfDoc.context.obj("Annots"),
                  pdfDoc.context.obj([linkAnnotationRef]),
                );
              }
            }
          }
        }
        indexPageNum++;
      }

      // Image-page external (QR) links
      for (let pNum = 0; pNum < imagePageObjects.length; pNum++) {
        const imagePage = imagePageObjects[pNum];
        if (
          imagePage._linkAnnotations &&
          imagePage._linkAnnotations.length > 0
        ) {
          const pdfLibPage = pages[indexPages.length + pNum];

          for (const linkInfo of imagePage._linkAnnotations) {
            if (linkInfo.isExternalLink) {
              try {
                const { PDFString } = await import("pdf-lib");

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
                  H: "I",
                  A: {
                    Type: "Action",
                    S: "URI",
                    URI: PDFString.of(linkInfo.url),
                  },
                });

                const urlLinkRef = pdfDoc.context.register(urlLinkAnnotation);

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

      const modifiedPdfBytes = await pdfDoc.save();
      fs.writeFileSync(outputPath, modifiedPdfBytes);

      console.log(`✓ Added clickable links to table of contents`);
    } catch (error) {
      console.warn("Note: Could not create clickable links:", error.message);
    }

    try {
      fs.rmSync(qrTempDir, { recursive: true, force: true });
    } catch (_) {}
    return;
  }

  // Finalize the PDF
  pdfWriter.end();

  try {
    fs.rmSync(qrTempDir, { recursive: true, force: true });
  } catch (_) {}

  console.log(
    `${instrument.file}\n   Total pages ${pageIndex}\n   Total Tunes: ${imageFiles.length}`,
  );
}

// Execute
for (const instrument of instruments) {
  combinePDFs(instrument).catch((error) =>
    console.error(`Error combining images for ${instrument.file}:`, error),
  );
}
