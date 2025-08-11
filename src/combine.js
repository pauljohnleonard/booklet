import muhammara from "muhammara";
import fs from "fs";
import path from "path";
import imageSize from "image-size"; // npm install image-size

// Group images into the fewest page-sets using First-Fit Decreasing by scaled height
function groupImagesIntoPages(images, contentHeight, scale, imageGap) {
  const items = images
    .map((img) => ({
      ...img,
      scaledHeight: img.height * scale,
    }))
    .sort((a, b) => b.scaledHeight - a.scaledHeight);

  const pages = []; // each page: { items: [], used: number }
  for (const item of items) {
    let placed = false;
    for (const page of pages) {
      const needed = (page.used > 0 ? imageGap : 0) + item.scaledHeight;
      if (page.used + needed <= contentHeight) {
        page.items.push(item);
        page.used += needed;
        placed = true;
        break;
      }
    }
    if (!placed) {
      pages.push({ items: [item], used: item.scaledHeight });
    }
  }
  // Strip helper properties
  return pages.map((p) => p.items.map(({ scaledHeight, ...rest }) => rest));
}

/**
 * Combines PNG files from the trimmed folder into a single optimized PDF document
 */
async function combinePDFs() {
  const trimmedDir = "trimmed";

  // Check if directory exists
  if (!fs.existsSync(trimmedDir)) {
    console.error("Error: 'trimmed' directory not found!");
    return;
  }

  // Get all PNG files from the trimmed directory
  const imageFiles = fs
    .readdirSync(trimmedDir)
    .filter((file) => file.toLowerCase().endsWith(".png"))
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

  // Create a new PDF writer
  const outputPath = "combined.pdf";

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
      "Warning: No TTF font found. Page numbers and index will be skipped."
    );
  }

  // Define margins in points (72 points = 1 inch)
  const margin = {
    top: 36,
    bottom: 36,
    left: 36,
    right: 36,
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

  // Compute a single global scale so the widest image fits horizontally
  const imageGap = 40;
  const maxWidthPx = Math.max(...validImages.map((i) => i.width));
  const scale = contentWidth / maxWidthPx; // To avoid upscaling, use: Math.min(1, contentWidth / maxWidthPx)

  // Group images into minimal page sets (order by best fit, not filename)
  const pages = groupImagesIntoPages(
    validImages,
    contentHeight,
    scale,
    imageGap
  );

  // Build and render the Index first (so it's the first page[s])
  if (font && validImages.length > 0) {
    // Calculate how many index pages we need
    const lineHeight = 14;
    const titleGap = 24;
    const linesFirst = Math.floor((contentHeight - titleGap) / lineHeight);
    const linesPer = Math.max(1, Math.floor(contentHeight / lineHeight));
    const totalEntries = validImages.length;
    const indexPageCount =
      totalEntries <= linesFirst
        ? 1
        : 1 + Math.ceil((totalEntries - linesFirst) / linesPer);

    // Precompute indexEntries with image-page numbers starting at 1
    indexEntries.push(
      ...pages.flatMap((items, pIdx) =>
        items.map((img) => ({
          title: img.filename
            .replace(/\.png$/i, "")
            .replace(/-Flute-\d+$/i, ""),
          page: pIdx + 1, // no offset from index pages
        }))
      )
    );

    // Sort by title
    const sorted = indexEntries.slice().sort((a, b) =>
      a.title.localeCompare(b.title, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

    // Render index pages now
    let idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
    let idxCtx = pdfWriter.startPageContentContext(idxPage);
    let y = pageHeight - margin.top;

    const titleSize = 16;
    const lineSize = 12;

    // Title on first index page
    idxCtx.writeText("Frome Balfolk Tunes", margin.left, y, { font, size: 20 });
    y -= titleGap;

    const columnWidth = contentWidth / 2;
    const columnRight = margin.left + columnWidth;
    const gap = 6;
    const dotChar = ".";
    let dotWidth = 0;
    try {
      dotWidth = font.calculateTextDimensions(dotChar, lineSize).width || 0;
    } catch (_) {}

    for (const item of sorted) {
      if (y < margin.bottom + lineHeight) {
        // close current index page (no page number on index pages)
        pdfWriter.writePage(idxPage);
        pageIndex++;

        // start a new index page (no title on subsequent pages)
        idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
        idxCtx = pdfWriter.startPageContentContext(idxPage);
        y = pageHeight - margin.top;
      }

      const pageText = String(item.page);
      let numWidth = 0;
      try {
        numWidth = font.calculateTextDimensions(pageText, lineSize).width || 0;
      } catch (_) {}
      const numX = columnRight - numWidth;

      let maxTitleWidth = numX - margin.left - gap - (dotWidth || 3);

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
        const dotStartX = margin.left + titleWidth + gap;
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

        // Draw: title (left), dots (middle), page number (right edge of half column)
        idxCtx.writeText(titleText, margin.left, y, { font, size: lineSize });
        if (dots)
          idxCtx.writeText(dots, dotStartX, y, { font, size: lineSize });
        idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
      } catch (_) {
        // Fallback: just draw minimally if anything fails
        idxCtx.writeText(titleText, margin.left, y, { font, size: lineSize });
        idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
      }

      y -= lineHeight;
    }

    // finalize last index page (no page number on index pages)
    pdfWriter.writePage(idxPage);
    pageIndex++;
  }

  // Start first image page (after index pages)
  let page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  let contentContext = pdfWriter.startPageContentContext(page);
  let currentY = pageHeight - margin.top;

  // Render page-by-page based on grouping
  for (let p = 0; p < pages.length; p++) {
    if (p > 0) {
      // finalize previous image page and start a new one
      if (font) drawPageNumber(contentContext, imagePageNumber + 1);
      pdfWriter.writePage(page);
      imagePageNumber++;
      pageIndex++;

      page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      contentContext = pdfWriter.startPageContentContext(page);
      currentY = pageHeight - margin.top;
    }

    for (const img of pages[p]) {
      const wPts = img.width * scale;
      const hPts = img.height * scale;

      // Safety: if something doesn't fit due to rounding, spill to a new page
      if (currentY - hPts < margin.bottom) {
        if (font) drawPageNumber(contentContext, imagePageNumber + 1);
        pdfWriter.writePage(page);
        imagePageNumber++;
        pageIndex++;

        page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
        contentContext = pdfWriter.startPageContentContext(page);
        currentY = pageHeight - margin.top;
      }

      const x = margin.left + (contentWidth - wPts) / 2;
      const y = currentY - hPts;

      contentContext.drawImage(x, y, img.path, {
        transformation: { width: wPts, height: hPts },
      });

      currentY -= hPts + imageGap;
    }
  }

  // Finalize the last image page
  if (font) drawPageNumber(contentContext, imagePageNumber + 1);
  pdfWriter.writePage(page);
  imagePageNumber++;
  pageIndex++;

  // Finalize the PDF
  pdfWriter.end();

  console.log(`Total pages: ${pageIndex}`);
}

// Execute the function
combinePDFs().catch((error) => console.error("Error combining images:", error));
