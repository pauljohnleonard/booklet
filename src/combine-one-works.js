import muhammara from "muhammara";
import fs from "fs";
import path from "path";
import imageSize from "image-size"; // npm install image-size

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

  // Sort images by filename (natural order) to preserve sequence
  const orderedImages = validImages.sort((a, b) =>
    a.filename.localeCompare(b.filename, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  // If nothing valid, exit early
  if (orderedImages.length === 0) {
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
  const pageLimitY = pageHeight - margin.top;

  // Row packing configuration
  const targetRowHeight = 180; // adjust if you want larger/smaller rows
  const rowGap = 8;
  const colGap = 8;

  // Start first page
  let page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  let contentContext = pdfWriter.startPageContentContext(page);
  let currentY = margin.bottom;

  // Shelf (justified rows) packing
  let row = [];
  let sumAR = 0; // sum of aspect ratios for the current row

  const flushRow = (justifyToWidth = true) => {
    if (row.length === 0) return;

    // Compute row height
    const gaps = (row.length - 1) * colGap;
    let rowHeight = justifyToWidth
      ? (contentWidth - gaps) / sumAR // fill width
      : Math.min(targetRowHeight, (contentWidth - gaps) / sumAR); // last row

    // Start a new page if row doesn't fit vertically
    if (currentY + rowHeight > pageLimitY) {
      pdfWriter.writePage(page);
      pageIndex++;
      page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      contentContext = pdfWriter.startPageContentContext(page);
      currentY = margin.bottom;

      // Recompute rowHeight against new page (no vertical overflow now)
      rowHeight = justifyToWidth
        ? (contentWidth - gaps) / sumAR
        : Math.min(targetRowHeight, (contentWidth - gaps) / sumAR);
    }

    // Draw row
    let x = margin.left;
    for (const r of row) {
      const wPts = r.ar * rowHeight;
      const hPts = rowHeight;

      // Draw PNG directly; this handles PNG decoding and alpha reliably
      contentContext.drawImage(x, currentY, r.path, {
        transformation: { width: wPts, height: hPts },
      });

      x += wPts + colGap;
    }

    currentY += rowHeight + rowGap;

    // Reset row
    row = [];
    sumAR = 0;
  };

  for (const img of orderedImages) {
    // Build rows until the target row height would exceed the content width
    const ar = img.width / img.height;
    row.push({ ...img, ar });
    sumAR += ar;

    const rowWidthAtTarget =
      sumAR * targetRowHeight + (row.length - 1) * colGap;
    if (rowWidthAtTarget >= contentWidth) {
      // Finalize and draw a justified row (fills width)
      flushRow(true);
    }
  }

  // Flush the last row (not strictly justified unless it would overflow)
  if (row.length > 0) {
    flushRow(false);
  }

  // Finalize the last page
  pdfWriter.writePage(page);
  pageIndex++;

  // Finalize the PDF
  pdfWriter.end();
  console.log(
    `Successfully combined ${orderedImages.length} images into ${outputPath}`
  );
  console.log(`Total pages: ${pageIndex}`);
}

// Execute the function
combinePDFs().catch((error) => console.error("Error combining images:", error));
